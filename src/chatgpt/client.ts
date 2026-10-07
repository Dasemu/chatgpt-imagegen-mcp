import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { audit } from "../log.js";
import type { InlineReferenceImage } from "../types.js";
import { ContentPolicyBlocked, ImageGenerationError, SessionNotReady, TurnTimedOut, UsageLimitReached } from "./errors.js";
import * as sel from "./selectors.js";

export const NAVIGATION_TIMEOUT_MS = 60_000;
export const COMPOSER_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 2_000;
export const TURN_START_TIMEOUT_MS = 30_000;
export const SETTLE_AFTER_TURN_MS = 3_000;
export const UPLOAD_TIMEOUT_MS = 90_000;
export const MIN_IMAGE_SIDE = 256;
export const STABLE_POLLS = 3;
export const TEXT_ONLY_GRACE_MS = 20_000;

export interface ImageCandidate {
  src: string;
  width: number;
  height: number;
  complete: boolean;
  inUserMessage: boolean;
}

export interface Timing {
  pollIntervalMs: number;
  turnStartTimeoutMs: number;
  settleAfterTurnMs: number;
  stablePolls: number;
  textOnlyGraceMs: number;
}

export const DEFAULT_TIMING: Timing = {
  pollIntervalMs: POLL_INTERVAL_MS,
  turnStartTimeoutMs: TURN_START_TIMEOUT_MS,
  settleAfterTurnMs: SETTLE_AFTER_TURN_MS,
  stablePolls: STABLE_POLLS,
  textOnlyGraceMs: TEXT_ONLY_GRACE_MS,
};

export function containsAny(text: string | undefined, markers: string[]): boolean {
  const normalized = (text || "").toLowerCase().replace(/[’`]/g, "'");
  return markers.some((marker) => normalized.includes(marker));
}

export function isProbablyImageUrl(src: string): boolean {
  if (!src) return false;
  if (src.startsWith("data:image/svg+xml")) return false;
  if (src.startsWith("data:image/") || src.startsWith("blob:")) return true;
  let parsed: URL;
  try { parsed = new URL(src); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const lower = src.toLowerCase();
  return !["/avatar", "profile-picture", "gravatar", ".svg", "favicon"].some((token) => lower.includes(token));
}

export function decodeDataUri(src: string): Buffer {
  const comma = src.indexOf(",");
  if (comma < 0) throw new ImageGenerationError("Malformed image data URI");
  if (!src.slice(0, comma).includes(";base64")) throw new ImageGenerationError("Image data URI is not base64 encoded");
  return Buffer.from(src.slice(comma + 1), "base64");
}

export function pickGeneratedImage(candidates: ImageCandidate[], baseline: Set<string>): ImageCandidate | undefined {
  const eligible = candidates.filter((candidate) =>
    !candidate.inUserMessage
    && !baseline.has(candidate.src)
    && isProbablyImageUrl(candidate.src)
    && candidate.width >= MIN_IMAGE_SIDE
    && candidate.height >= MIN_IMAGE_SIDE);
  return eligible.at(-1);
}

export async function firstVisible(page: Page, selectors: string[], timeoutMs = 0): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count() > 0 && await locator.isVisible()) return locator;
      } catch {
        // Invalid or detached selector: try the next alternative.
      }
    }
    if (Date.now() >= deadline) return undefined;
    await page.waitForTimeout(500);
  }
}

export async function firstAttached(page: Page, selectors: string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0) > 0) return locator;
  }
  return undefined;
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  if (await firstVisible(page, sel.LOGIN_MARKERS)) return false;
  return Boolean(await firstAttached(page, sel.LOGGED_IN_MARKERS));
}

export async function ensureSession(page: Page): Promise<void> {
  if (await firstVisible(page, sel.LOGIN_MARKERS)) throw new SessionNotReady();
}

export async function dismissModals(page: Page): Promise<void> {
  for (const selector of sel.DISMISS_BUTTONS) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() > 0 && await locator.isVisible()) {
        await locator.click({ timeout: 2000 });
        await page.waitForTimeout(500);
      }
    } catch {
      // Modal vanished on its own.
    }
  }
}

export async function openNewChat(page: Page, url: string, diagnostics?: Diagnostics): Promise<void> {
  // The root URL always opens an empty thread; clicking "New chat" is less stable.
  await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await ensureSession(page);
  await dismissModals(page);
  if (!await firstVisible(page, sel.COMPOSER, COMPOSER_TIMEOUT_MS)) {
    await diagnostics?.save(page, "composer-not-found");
    throw new ImageGenerationError("chatgpt.com composer not found; check selectors.COMPOSER", "UI_CHANGED");
  }
}

export async function attachReferences(page: Page, references: InlineReferenceImage[], diagnostics?: Diagnostics, timing = DEFAULT_TIMING): Promise<void> {
  if (references.length === 0) return;
  const input = await firstAttached(page, sel.FILE_INPUT);
  if (!input) {
    await diagnostics?.save(page, "file-input-not-found");
    throw new ImageGenerationError("chatgpt.com file input not found; check selectors.FILE_INPUT", "UI_CHANGED");
  }
  await input.setInputFiles(references.map((reference, index) => ({
    name: `reference-${index + 1}.${reference.mime_type.split("/")[1].replace("jpeg", "jpg")}`,
    mimeType: reference.mime_type,
    buffer: Buffer.from(reference.base64, "base64"),
  })));
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  await page.waitForTimeout(timing.pollIntervalMs);
  while (Date.now() < deadline) {
    const uploading = await firstVisible(page, sel.ATTACHMENT_IN_PROGRESS);
    const send = await firstVisible(page, sel.SEND_BUTTON);
    if (!uploading && (!send || await send.isEnabled())) return;
    await page.waitForTimeout(timing.pollIntervalMs);
  }
  await diagnostics?.save(page, "reference-upload-timeout");
  throw new TurnTimedOut(`Reference images did not finish uploading in ${UPLOAD_TIMEOUT_MS / 1000}s`);
}

export async function sendMessage(page: Page, text: string, diagnostics?: Diagnostics): Promise<void> {
  const composer = await firstVisible(page, sel.COMPOSER, COMPOSER_TIMEOUT_MS);
  if (!composer) {
    await diagnostics?.save(page, "composer-unavailable");
    throw new ImageGenerationError("Composer unavailable when sending the message", "UI_CHANGED");
  }
  await composer.click({ timeout: 10_000 });
  try {
    await composer.fill(text, { timeout: 10_000 });
  } catch {
    await page.keyboard.insertText(text);
  }
  await page.waitForTimeout(400 + Math.floor(Math.random() * 800));
  const send = await firstVisible(page, sel.SEND_BUTTON);
  if (send) {
    try {
      await send.click({ timeout: 5000 });
      return;
    } catch {
      // Fall back to Enter below.
    }
  }
  await page.keyboard.press("Enter");
}

export async function lastAssistantText(page: Page): Promise<string> {
  for (const selector of sel.ASSISTANT_MESSAGE) {
    try {
      const locator = page.locator(selector);
      if (await locator.count() > 0) return await locator.last().innerText({ timeout: 5000 });
    } catch {
      // Try the next alternative.
    }
  }
  return "";
}

export async function raiseIfBlocked(page: Page): Promise<void> {
  const banner = await firstVisible(page, sel.ERROR_BANNER);
  const bannerText = banner ? await banner.innerText({ timeout: 2000 }).catch(() => "") : "";
  // Only the banner and the assistant reply are checked: the user's own prompt may contain any words.
  const reply = await lastAssistantText(page);
  if (containsAny(bannerText, sel.USAGE_LIMIT_TEXTS) || containsAny(reply, sel.USAGE_LIMIT_TEXTS)) {
    throw new UsageLimitReached(`ChatGPT reports a usage limit: ${(bannerText || reply).slice(0, 300)}`);
  }
}

export async function waitForTurnComplete(page: Page, timeoutMs: number, diagnostics?: Diagnostics, timing = DEFAULT_TIMING): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startedDeadline = Math.min(deadline, Date.now() + timing.turnStartTimeoutMs);
  while (Date.now() < startedDeadline) {
    if (await firstVisible(page, sel.STOP_BUTTON)) break;
    await page.waitForTimeout(timing.pollIntervalMs);
  }
  let consecutiveIdle = 0;
  while (Date.now() < deadline) {
    await raiseIfBlocked(page);
    if (await firstVisible(page, sel.STOP_BUTTON)) {
      consecutiveIdle = 0;
    } else if (++consecutiveIdle >= 2) {
      await page.waitForTimeout(timing.settleAfterTurnMs);
      return;
    }
    await page.waitForTimeout(timing.pollIntervalMs);
  }
  await diagnostics?.save(page, "turn-timeout");
  throw new TurnTimedOut(`ChatGPT did not finish the turn in ${Math.round(timeoutMs / 1000)}s`);
}

export async function collectImageCandidates(page: Page): Promise<ImageCandidate[]> {
  return page.evaluate((userSelectors) => Array.from(document.querySelectorAll("img")).map((img) => ({
    src: img.currentSrc || img.src,
    width: img.naturalWidth,
    height: img.naturalHeight,
    complete: img.complete,
    inUserMessage: userSelectors.some((selector) => img.closest(selector) !== null),
  })), sel.USER_MESSAGE);
}

export async function imageSources(page: Page): Promise<Set<string>> {
  return new Set((await collectImageCandidates(page)).map((candidate) => candidate.src));
}

/**
 * Waits for a new, fully loaded image outside our own message whose src stays the same for a few
 * polls. ChatGPT first shows blurred partial previews, so the first image seen is not the final one.
 */
export async function waitForGeneratedImage(page: Page, baseline: Set<string>, timeoutMs: number, diagnostics?: Diagnostics, timing = DEFAULT_TIMING): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const textOnlyDeadline = Date.now() + timing.textOnlyGraceMs;
  let lastSrc = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    await raiseIfBlocked(page);
    const reply = await lastAssistantText(page);
    const inProgress = containsAny(reply, sel.IMAGE_IN_PROGRESS_TEXTS) || Boolean(await firstVisible(page, sel.STOP_BUTTON));
    const candidate = pickGeneratedImage(await collectImageCandidates(page), baseline);
    if (candidate && candidate.complete && !inProgress) {
      stableCount = candidate.src === lastSrc ? stableCount + 1 : 1;
      lastSrc = candidate.src;
      if (stableCount >= timing.stablePolls) return candidate.src;
    } else {
      stableCount = 0;
      lastSrc = candidate?.src ?? "";
    }
    if (!candidate && !inProgress && Date.now() > textOnlyDeadline && reply.trim()) {
      await diagnostics?.save(page, "text-reply-without-image");
      if (containsAny(reply, sel.CONTENT_POLICY_TEXTS)) throw new ContentPolicyBlocked(`ChatGPT refused the request: ${reply.slice(0, 500)}`);
      if (containsAny(reply, sel.TRANSIENT_ERROR_TEXTS)) throw new ImageGenerationError(`ChatGPT returned an error: ${reply.slice(0, 500)}`);
      throw new ImageGenerationError(`ChatGPT replied with text instead of an image: ${reply.slice(0, 500)}`, "NO_IMAGE_RETURNED");
    }
    await page.waitForTimeout(timing.pollIntervalMs);
  }
  await diagnostics?.save(page, "image-not-found");
  throw new TurnTimedOut(`No generated image appeared in ${Math.round(timeoutMs / 1000)}s; check selectors and diagnostics`);
}

export async function downloadImage(page: Page, src: string): Promise<Buffer> {
  if (src.startsWith("data:")) return decodeDataUri(src);
  if (src.startsWith("blob:")) {
    const base64 = await page.evaluate(async (url) => {
      const blob = await (await fetch(url)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return btoa(binary);
    }, src);
    return Buffer.from(base64, "base64");
  }
  // The browser request context carries the session cookies; a plain fetch from Node gets 403.
  const response = await page.request.get(src, { timeout: 120_000 });
  if (!response.ok()) throw new ImageGenerationError(`Image download failed: HTTP ${response.status()}`);
  return response.body();
}

export class Diagnostics {
  constructor(private readonly dir: string, private readonly keep: number) {}

  /** Dumps HTML + screenshot of the current page. Never throws. Files may contain conversation text. */
  async save(page: Page, reason: string): Promise<string | undefined> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o750 });
      const slug = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const base = path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`);
      await writeFile(`${base}.html`, await page.content(), { mode: 0o640 });
      await page.screenshot({ path: `${base}.png`, fullPage: false, timeout: 10_000 }).catch(() => undefined);
      await this.prune();
      audit("diagnostic_saved", { reason, file: path.basename(base) });
      return base;
    } catch {
      return undefined;
    }
  }

  private async prune(): Promise<void> {
    const entries = await readdir(this.dir);
    const htmlFiles = await Promise.all(entries.filter((name) => name.endsWith(".html")).map(async (name) => ({ name, mtime: (await stat(path.join(this.dir, name))).mtimeMs })));
    htmlFiles.sort((a, b) => a.mtime - b.mtime);
    for (const stale of htmlFiles.slice(0, Math.max(0, htmlFiles.length - this.keep))) {
      const base = path.join(this.dir, stale.name.slice(0, -5));
      await unlink(`${base}.html`).catch(() => undefined);
      await unlink(`${base}.png`).catch(() => undefined);
    }
  }
}
