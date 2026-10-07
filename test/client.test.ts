import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  attachReferences, collectImageCandidates, downloadImage, ensureSession, firstAttached, firstVisible, imageSources, isLoggedIn,
  lastAssistantText, raiseIfBlocked, sendMessage, waitForGeneratedImage, waitForTurnComplete, type Timing,
} from "../src/chatgpt/client.js";
import { ContentPolicyBlocked, ImageGenerationError, SessionNotReady, UsageLimitReached } from "../src/chatgpt/errors.js";
import { makePng, pngDataUri } from "./helpers.js";

const BIG_IMG = pngDataUri(300, 300);
const SMALL_IMG = pngDataUri(32, 32);
const fast: Timing = { pollIntervalMs: 50, turnStartTimeoutMs: 200, settleAfterTurnMs: 10, stablePolls: 2, textOnlyGraceMs: 300 };

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").replaceAll("{{BIG_IMG}}", BIG_IMG).replaceAll("{{SMALL_IMG}}", SMALL_IMG);
}

let browser: Browser | undefined;
let skipReason: string | undefined;
try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  skipReason = `Chromium could not be launched (${(error as Error).message.split("\n")[0]}); set PLAYWRIGHT_BROWSERS_PATH to a Playwright browsers directory`;
  console.warn(`SKIPPING test/client.test.ts: ${skipReason}`);
}

describe("chatgpt client (DOM fixtures)", { skip: skipReason }, () => {
  let page: Page;
  before(async () => { page = await (await browser!.newContext()).newPage(); });
  after(async () => { await browser?.close(); });

  const load = (html: string) => page.setContent(html, { waitUntil: "load" });

  describe("session", () => {
    it("isLoggedIn is false for a guest and true for a logged-in page", async () => {
      await load(fixture("chatgpt-login.html"));
      assert.equal(await isLoggedIn(page), false);
      await load(fixture("chatgpt-new-chat.html"));
      assert.equal(await isLoggedIn(page), true);
    });
    it("a composer alone does not count as logged in", async () => {
      await load('<div id="prompt-textarea" contenteditable="true"></div>');
      assert.equal(await isLoggedIn(page), false);
    });
    it("ensureSession throws SessionNotReady on the guest page only", async () => {
      await load(fixture("chatgpt-login.html"));
      await assert.rejects(ensureSession(page), SessionNotReady);
      await load(fixture("chatgpt-new-chat.html"));
      await assert.doesNotReject(ensureSession(page));
    });
  });

  describe("locators", () => {
    it("firstVisible skips missing, hidden and invalid selectors", async () => {
      await load('<div id="hidden" style="display:none">h</div><div class="shown" id="second">s</div>');
      const found = await firstVisible(page, ["#missing", "#hidden", "div[[invalid", ".shown"]);
      assert.equal(await found?.getAttribute("id"), "second");
      assert.equal(await firstVisible(page, ["#missing", "#hidden"]), undefined);
    });
    it("firstVisible waits for an element that appears later", async () => {
      await load('<script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", \'<p id="late">x</p>\'); }, 150);</script>');
      assert.ok(await firstVisible(page, ["#late"], 2000));
    });
    it("firstAttached finds hidden elements", async () => {
      await load(fixture("chatgpt-new-chat.html"));
      assert.ok(await firstAttached(page, ["#nope", 'input[type="file"]']));
      assert.equal(await firstAttached(page, ["#nope"]), undefined);
    });
  });

  describe("images", () => {
    it("collectImageCandidates marks images inside user messages", async () => {
      await load(fixture("chatgpt-conversation-with-image.html"));
      const candidates = await collectImageCandidates(page);
      const reference = candidates.filter((candidate) => candidate.inUserMessage);
      assert.equal(reference.length, 1);
      assert.equal(reference[0].width, 32);
      const generated = candidates.find((candidate) => candidate.width === 300);
      assert.ok(generated);
      assert.equal(generated.inUserMessage, false);
      assert.equal(generated.complete, true);
    });
    it("imageSources returns the set of current srcs", async () => {
      await load(fixture("chatgpt-conversation-with-image.html"));
      const sources = await imageSources(page);
      assert.ok(sources.has(BIG_IMG));
      assert.ok(sources.has(SMALL_IMG));
    });
    it("downloadImage decodes data URIs", async () => {
      const bytes = await downloadImage(page, BIG_IMG);
      assert.ok(bytes.equals(makePng(300, 300)));
      await assert.rejects(downloadImage(page, "data:image/png,not-base64"), ImageGenerationError);
    });
    it("downloadImage reads blob URLs in the page", async () => {
      await load("<p>blob</p>");
      const png = makePng(300, 300);
      const blobUrl = await page.evaluate((base64) => URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" })), png.toString("base64"));
      assert.ok((await downloadImage(page, blobUrl)).equals(png));
    });
  });

  describe("waitForGeneratedImage", () => {
    it("returns the assistant image src, ignoring the user's reference", async () => {
      await load(fixture("chatgpt-conversation-with-image.html"));
      assert.equal(await waitForGeneratedImage(page, new Set(), 5000, undefined, fast), BIG_IMG);
    });
    it("ignores images present in the baseline (text reply only)", async () => {
      await load(fixture("chatgpt-conversation-with-image.html"));
      await assert.rejects(waitForGeneratedImage(page, new Set([BIG_IMG]), 5000, undefined, fast), { code: "NO_IMAGE_RETURNED" });
    });
    it("times out while the image never finishes", async () => {
      await load('<div data-message-author-role="assistant">Creating image</div>');
      await assert.rejects(waitForGeneratedImage(page, new Set(), 600, undefined, fast), { code: "TURN_TIMED_OUT" });
    });
    it("waits while the image is still being created", async () => {
      await load(`<div data-message-author-role="assistant" id="reply">Creating image</div>
        <script>setTimeout(() => {
          document.getElementById("reply").innerHTML = 'Done <img src="${BIG_IMG}">';
        }, 300);</script>`);
      const started = Date.now();
      assert.equal(await waitForGeneratedImage(page, new Set(), 5000, undefined, fast), BIG_IMG);
      assert.ok(Date.now() - started >= 250);
    });
    it("throws ContentPolicyBlocked for a refusal without an image", async () => {
      await load('<div data-message-author-role="assistant">I can’t help with that request because it may violate our content policy.</div>');
      await assert.rejects(waitForGeneratedImage(page, new Set(), 5000, undefined, fast), ContentPolicyBlocked);
    });
    it("throws NO_IMAGE_RETURNED for an unrelated text reply", async () => {
      await load('<div data-message-author-role="assistant">What colour should the fox be?</div>');
      await assert.rejects(waitForGeneratedImage(page, new Set(), 5000, undefined, fast), { code: "NO_IMAGE_RETURNED" });
    });
    it("throws a generic error for a transient error reply", async () => {
      await load('<div data-message-author-role="assistant">Something went wrong. Please try again.</div>');
      await assert.rejects(waitForGeneratedImage(page, new Set(), 5000, undefined, fast), (error: ImageGenerationError) => {
        assert.equal(error.code, "GENERATION_FAILED");
        assert.match(error.message, /returned an error/);
        return true;
      });
    });
  });

  describe("raiseIfBlocked / lastAssistantText", () => {
    it("lastAssistantText returns the last assistant message", async () => {
      await load('<div data-message-author-role="assistant">first</div><div data-message-author-role="user">mine</div><div data-message-author-role="assistant">second</div>');
      assert.equal(await lastAssistantText(page), "second");
      await load("<p>nothing</p>");
      assert.equal(await lastAssistantText(page), "");
    });
    it("throws UsageLimitReached from the assistant message", async () => {
      await load("<div data-message-author-role=\"assistant\">You've hit the plus plan limit for image generations. Try again later.</div>");
      await assert.rejects(raiseIfBlocked(page), UsageLimitReached);
    });
    it("throws UsageLimitReached from an alert banner", async () => {
      await load('<div role="alert">You’ve reached our limit of messages</div>');
      await assert.rejects(raiseIfBlocked(page), UsageLimitReached);
    });
    it("ignores usage-limit words in the user's own prompt", async () => {
      await load('<div data-message-author-role="user">draw a usage limit sign</div><div data-message-author-role="assistant">Sure.</div>');
      await assert.doesNotReject(raiseIfBlocked(page));
    });
  });

  describe("waitForTurnComplete", () => {
    it("resolves after the stop button disappears", async () => {
      await load(`<button data-testid="stop-button">Stop</button>
        <script>setTimeout(() => document.querySelector('[data-testid="stop-button"]').remove(), 400);</script>`);
      const started = Date.now();
      await waitForTurnComplete(page, 5000, undefined, fast);
      assert.ok(Date.now() - started >= 350, "returned before the stop button was removed");
    });
    it("resolves quickly when no turn ever starts", async () => {
      await load("<p>idle</p>");
      const started = Date.now();
      await waitForTurnComplete(page, 5000, undefined, fast);
      assert.ok(Date.now() - started < 1500);
    });
    it("times out while the stop button stays", async () => {
      await load('<button data-testid="stop-button">Stop</button>');
      await assert.rejects(waitForTurnComplete(page, 400, undefined, fast), { code: "TURN_TIMED_OUT" });
    });
    it("surfaces a usage limit shown during the turn", async () => {
      await load("<button data-testid=\"stop-button\">Stop</button><div data-message-author-role=\"assistant\">You've hit the plus plan limit</div>");
      await assert.rejects(waitForTurnComplete(page, 2000, undefined, fast), UsageLimitReached);
    });
  });

  describe("composer", () => {
    it("sendMessage fills the contenteditable and clicks send", async () => {
      await load(fixture("chatgpt-new-chat.html"));
      await sendMessage(page, "Draw a fox\nwith two lines");
      const turns = await page.locator('[data-message-author-role="user"]').allInnerTexts();
      assert.equal(turns.length, 1);
      assert.match(turns[0], /Draw a fox\s+with two lines/);
      assert.equal((await page.locator("#prompt-textarea").innerText()).trim(), "", "composer cleared by the fixture's send handler");
    });
    it("sendMessage falls back to Enter without a send button", async () => {
      await load(`<div id="prompt-textarea" contenteditable="true"></div><div id="log"></div>
        <script>document.getElementById("prompt-textarea").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("log").textContent = "enter:" + e.target.innerText; });</script>`);
      await sendMessage(page, "hello");
      assert.equal(await page.locator("#log").innerText(), "enter:hello");
    });
  });

  describe("attachReferences", () => {
    it("is a no-op without references", async () => {
      await load("<p>nothing</p>");
      await assert.doesNotReject(attachReferences(page, [], undefined, fast));
    });
    it("sets the files on the input", async () => {
      await load(fixture("chatgpt-new-chat.html"));
      const png = makePng(8, 8);
      await attachReferences(page, [
        { base64: png.toString("base64"), mime_type: "image/png" },
        { base64: png.toString("base64"), mime_type: "image/jpeg" },
      ], undefined, fast);
      assert.equal(await page.locator("#files").evaluate((input) => (input as HTMLInputElement).files!.length), 2);
      const previews = await page.locator(".preview").allInnerTexts();
      assert.deepEqual(previews, [`reference-1.png:image/png:${png.length}`, `reference-2.jpg:image/jpeg:${png.length}`]);
    });
    it("throws UI_CHANGED without a file input", async () => {
      await load("<p>no input</p>");
      await assert.rejects(
        attachReferences(page, [{ base64: makePng(8, 8).toString("base64"), mime_type: "image/png" }], undefined, fast),
        { code: "UI_CHANGED" },
      );
    });
  });
});
