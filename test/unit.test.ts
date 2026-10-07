import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { normalizeArguments, resolveModel } from "../src/arguments.js";
import {
  containsAny, decodeDataUri, isProbablyImageUrl, pickGeneratedImage, type ImageCandidate,
} from "../src/chatgpt/client.js";
import { ContentPolicyBlocked, ImageGenerationError, SessionNotReady, TurnTimedOut, UsageLimitReached } from "../src/chatgpt/errors.js";
import type { ImageProvider } from "../src/chatgpt/provider.js";
import { buildImageRequest } from "../src/chatgpt/prompts.js";
import { extensionFor, imageDimensions, sniffImageMime } from "../src/image.js";
import { JobManager, toJobError, type JobManagerOptions } from "../src/jobs.js";
import { ensureMediaDir, loadPersistedJob, outputPayload, storeImage } from "../src/media.js";
import type { GenerationJob, ImageRequest, StoredOutput } from "../src/types.js";
import { makePng } from "./helpers.js";

before(async () => { await ensureMediaDir(); });

// Real images generated with Pillow: JPEG 13x7, lossy WebP 11x5, lossless WebP 9x6.
const JPEG_13x7 = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAHAA0DASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkKKKK8U/TD//Z", "base64");
const WEBP_LOSSY_11x5 = Buffer.from("UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoLAAUAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA", "base64");
const WEBP_LOSSLESS_9x6 = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvCEABAAdQjyLXo/+BiOh/AAA=", "base64");

describe("image", () => {
  it("sniffs and measures a PNG", () => {
    const png = makePng(17, 9);
    assert.equal(sniffImageMime(png), "image/png");
    assert.deepEqual(imageDimensions(png), { width: 17, height: 9 });
  });
  it("sniffs and measures a JPEG", () => {
    assert.equal(sniffImageMime(JPEG_13x7), "image/jpeg");
    assert.deepEqual(imageDimensions(JPEG_13x7), { width: 13, height: 7 });
  });
  it("sniffs and measures WebP (lossy and lossless)", () => {
    assert.equal(sniffImageMime(WEBP_LOSSY_11x5), "image/webp");
    assert.deepEqual(imageDimensions(WEBP_LOSSY_11x5), { width: 11, height: 5 });
    assert.equal(sniffImageMime(WEBP_LOSSLESS_9x6), "image/webp");
    assert.deepEqual(imageDimensions(WEBP_LOSSLESS_9x6), { width: 9, height: 6 });
  });
  it("rejects non-images and truncated data", () => {
    assert.equal(sniffImageMime(Buffer.from("hello world, not an image")), undefined);
    assert.equal(sniffImageMime(Buffer.alloc(0)), undefined);
    assert.equal(imageDimensions(Buffer.from("GIF89a....")), undefined);
    assert.equal(imageDimensions(makePng(4, 4).subarray(0, 12)), undefined);
  });
  it("maps mime types to extensions", () => {
    assert.equal(extensionFor("image/png"), "png");
    assert.equal(extensionFor("image/jpeg"), "jpg");
    assert.equal(extensionFor("image/webp"), "webp");
  });
});

describe("resolveModel", () => {
  it("accepts the name and aliases case-insensitively", () => {
    assert.equal(resolveModel("chatgpt-web"), "chatgpt-web");
    assert.equal(resolveModel("  GPT-Image "), "chatgpt-web");
    assert.equal(resolveModel("chatgpt"), "chatgpt-web");
    assert.equal(resolveModel("chatgpt-image"), "chatgpt-web");
  });
  it("rejects unknown models", () => {
    assert.throws(() => resolveModel("dall-e-3"), /Unknown model 'dall-e-3'/);
  });
});

describe("normalizeArguments", () => {
  const prompt = { name: "prompt", value: "a red fox" };
  const pngB64 = makePng(4, 4).toString("base64");

  it("applies defaults", () => {
    assert.deepEqual(normalizeArguments([prompt]), { prompt: "a red fox", aspect_ratio: "auto", image_count: 1 });
  });
  it("accepts explicit values", () => {
    const result = normalizeArguments([prompt, { name: "aspect_ratio", value: "16:9" }, { name: "image_count", value: 4 }]);
    assert.equal(result.aspect_ratio, "16:9");
    assert.equal(result.image_count, 4);
  });
  it("rejects bad input", () => {
    assert.throws(() => normalizeArguments([prompt, { name: "bogus", value: 1 }]), /Unknown argument 'bogus'/);
    assert.throws(() => normalizeArguments([prompt, prompt]), /Duplicate argument 'prompt'/);
    assert.throws(() => normalizeArguments([]), /Missing required argument 'prompt'/);
    assert.throws(() => normalizeArguments([{ name: "prompt", value: "   " }]), /Missing required argument 'prompt'/);
    assert.throws(() => normalizeArguments([{ name: "prompt", value: 42 }]), /Missing required argument 'prompt'/);
    assert.throws(() => normalizeArguments([{ name: "prompt", value: "x".repeat(8001) }]), /at most 8000/);
    assert.doesNotThrow(() => normalizeArguments([{ name: "prompt", value: "x".repeat(8000) }]));
    assert.throws(() => normalizeArguments([prompt, { name: "aspect_ratio", value: "7:3" }]), /Invalid 'aspect_ratio'/);
    assert.throws(() => normalizeArguments([prompt, { name: "aspect_ratio", value: 1 }]), /Invalid 'aspect_ratio'/);
    for (const bad of [0, 5, 1.5, "2", -1]) {
      assert.throws(() => normalizeArguments([prompt, { name: "image_count", value: bad }]), /image_count/, `image_count ${String(bad)}`);
    }
  });

  describe("reference_images", () => {
    const withRefs = (value: unknown) => normalizeArguments([prompt, { name: "reference_images", value }]).reference_images;

    it("accepts inline base64 with mime_type", () => {
      assert.deepEqual(withRefs([{ base64: pngB64, mime_type: "image/png" }]), [{ base64: pngB64, mime_type: "image/png" }]);
    });
    it("accepts a data URI and derives the mime type", () => {
      assert.deepEqual(withRefs([{ base64: `data:image/png;base64,${pngB64}` }]), [{ base64: pngB64, mime_type: "image/png" }]);
    });
    it("rejects a mime type that does not match the content", () => {
      assert.throws(() => withRefs([{ base64: pngB64, mime_type: "image/jpeg" }]), /does not match image\/jpeg/);
      assert.throws(() => withRefs([{ base64: `data:image/webp;base64,${pngB64}` }]), /does not match image\/webp/);
    });
    it("rejects invalid base64, missing or unsupported mime type", () => {
      assert.throws(() => withRefs([{ base64: "not base64!!", mime_type: "image/png" }]), /not valid standard base64/);
      assert.throws(() => withRefs([{ base64: pngB64.slice(1), mime_type: "image/png" }]), /not valid standard base64/);
      assert.throws(() => withRefs([{ base64: pngB64 }]), /mime_type must be/);
      assert.throws(() => withRefs([{ base64: pngB64, mime_type: "image/gif" }]), /mime_type must be/);
      assert.throws(() => withRefs([{ base64: "" , mime_type: "image/png" }]), /non-empty string/);
    });
    it("accepts generation_id references with default index 0", () => {
      const id = randomUUID();
      assert.deepEqual(withRefs([{ generation_id: id }, { generation_id: id, index: 2 }]), [
        { generation_id: id, index: 0 }, { generation_id: id, index: 2 },
      ]);
    });
    it("rejects bad generation references and shapes", () => {
      assert.throws(() => withRefs([{ generation_id: "nope" }]), /valid UUID/);
      assert.throws(() => withRefs([{ generation_id: randomUUID(), index: -1 }]), /non-negative integer/);
      assert.throws(() => withRefs([{ generation_id: randomUUID(), base64: pngB64 }]), /not both/);
      assert.throws(() => withRefs([]), /1 to 4/);
      assert.throws(() => withRefs("x"), /1 to 4/);
      assert.throws(() => withRefs(Array.from({ length: 5 }, () => ({ base64: pngB64, mime_type: "image/png" }))), /1 to 4/);
      assert.throws(() => withRefs([null]), /must be an object/);
    });
  });
});

describe("buildImageRequest", () => {
  it("omits the aspect ratio for auto", () => {
    const text = buildImageRequest("a cat", "auto", 0);
    assert.doesNotMatch(text, /aspect ratio/);
  });
  it("mentions the aspect ratio otherwise", () => {
    const text = buildImageRequest("a cat", "9:16", 0);
    assert.match(text, /9:16 aspect ratio \(vertical format\)/);
  });
  it("phrases reference counts", () => {
    assert.doesNotMatch(buildImageRequest("a cat", "auto", 0), /attached/);
    assert.match(buildImageRequest("a cat", "auto", 1), /Use the attached image as the reference/);
    assert.match(buildImageRequest("a cat", "auto", 3), /Use the 3 attached images as the references/);
  });
  it("keeps the prompt verbatim at the end (trimmed)", () => {
    const prompt = "line one\n\n  line two with \"quotes\" and 9:16 inside";
    assert.ok(buildImageRequest(`  ${prompt}\n`, "1:1", 2).endsWith(`\n\n${prompt}`));
  });
});

describe("client pure helpers", () => {
  it("containsAny is case-insensitive and normalises curly apostrophes", () => {
    assert.equal(containsAny("You’ve HIT the Plus Plan Limit", ["you've hit the plus plan limit"]), true);
    assert.equal(containsAny("You`ve hit the limit", ["you've hit the limit"]), true);
    assert.equal(containsAny("all good", ["usage limit"]), false);
    assert.equal(containsAny(undefined, ["usage limit"]), false);
    assert.equal(containsAny("anything", []), false);
  });

  it("isProbablyImageUrl", () => {
    assert.equal(isProbablyImageUrl(""), false);
    assert.equal(isProbablyImageUrl("data:image/svg+xml;base64,AAAA"), false);
    assert.equal(isProbablyImageUrl("data:image/png;base64,AAAA"), true);
    assert.equal(isProbablyImageUrl("blob:https://chatgpt.com/1234"), true);
    assert.equal(isProbablyImageUrl("https://files.oaiusercontent.com/file-abc"), true);
    assert.equal(isProbablyImageUrl("https://chatgpt.com/avatar/me.png"), false);
    assert.equal(isProbablyImageUrl("https://example.com/profile-picture/1"), false);
    assert.equal(isProbablyImageUrl("https://example.com/logo.svg"), false);
    assert.equal(isProbablyImageUrl("https://example.com/favicon.ico"), false);
    assert.equal(isProbablyImageUrl("ftp://example.com/a.png"), false);
    assert.equal(isProbablyImageUrl("/relative/a.png"), false);
  });

  it("decodeDataUri", () => {
    const png = makePng(2, 2);
    assert.ok(decodeDataUri(`data:image/png;base64,${png.toString("base64")}`).equals(png));
    assert.throws(() => decodeDataUri("data:image/png;base64"), /Malformed/);
    assert.throws(() => decodeDataUri("data:image/png,abcd"), /not base64/);
  });

  it("pickGeneratedImage excludes user, baseline and small images and picks the last eligible", () => {
    const make = (src: string, extra: Partial<ImageCandidate> = {}): ImageCandidate => ({
      src, width: 1024, height: 1024, complete: true, inUserMessage: false, ...extra,
    });
    const candidates = [
      make("https://x.test/user.png", { inUserMessage: true }),
      make("https://x.test/old.png"),
      make("https://x.test/small.png", { width: 255 }),
      make("https://x.test/flat.png", { height: 100 }),
      make("https://x.test/first.png"),
      make("https://x.test/avatar/me.png"),
      make("https://x.test/last.png"),
    ];
    assert.equal(pickGeneratedImage(candidates, new Set(["https://x.test/old.png"]))?.src, "https://x.test/last.png");
    assert.equal(pickGeneratedImage(candidates.slice(0, 4), new Set(["https://x.test/old.png"])), undefined);
    assert.equal(pickGeneratedImage([make("a", { width: 256, height: 256 })].map((c) => ({ ...c, src: "https://x.test/edge.png" })), new Set())?.src, "https://x.test/edge.png");
  });
});

describe("toJobError", () => {
  it("maps ImageGenerationError codes and retryability", () => {
    assert.deepEqual(toJobError(new UsageLimitReached("limit")), { code: "USAGE_LIMIT_REACHED", message: "limit", retryable: true });
    assert.deepEqual(toJobError(new TurnTimedOut("slow")), { code: "TURN_TIMED_OUT", message: "slow", retryable: true });
    assert.equal(toJobError(new SessionNotReady()).code, "SESSION_NOT_READY");
    assert.equal(toJobError(new SessionNotReady()).retryable, false);
    assert.deepEqual(toJobError(new ContentPolicyBlocked("no")), { code: "CONTENT_POLICY_BLOCKED", message: "no", retryable: false });
    assert.deepEqual(toJobError(new ImageGenerationError("x", "NO_IMAGE_RETURNED")), { code: "NO_IMAGE_RETURNED", message: "x", retryable: true });
    assert.deepEqual(toJobError(new ImageGenerationError("x", "UI_CHANGED")), { code: "UI_CHANGED", message: "x", retryable: false });
    assert.deepEqual(toJobError(new ImageGenerationError("x")), { code: "GENERATION_FAILED", message: "x", retryable: true });
  });
  it("maps generic errors", () => {
    assert.equal(toJobError(new Error("page.goto: Timeout 60000ms exceeded")).code, "BROWSER_ERROR");
    assert.equal(toJobError(new Error("net::ERR_CONNECTION_RESET")).code, "BROWSER_ERROR");
    assert.equal(toJobError(new Error("Executable doesn't exist at /x")).code, "SERVER_NOT_CONFIGURED");
    assert.equal(toJobError(new Error("ProcessSingleton lock")).retryable, false);
    assert.deepEqual(toJobError("boom"), { code: "GENERATION_FAILED", message: "boom", retryable: false });
    assert.equal(toJobError(new Error("y".repeat(5000))).message.length, 2000);
  });
});

describe("JobManager", () => {
  const options: JobManagerOptions = { minIntervalMs: 0, maxIntervalMs: 0, usageLimitCooldownMs: 60000, sessionRecheckMs: 60000, maxQueueLength: 2 };
  const png = makePng(32, 32);
  const args = (extra: Record<string, unknown> = {}) => ({ prompt: "p", aspect_ratio: "auto", image_count: 1, ...extra });

  class FakeProvider implements ImageProvider {
    calls: Array<{ generationId: string; request: ImageRequest }> = [];
    active = 0;
    maxActive = 0;
    sessionResult = true;
    gate?: Promise<void>;
    behaviour: (call: number) => Promise<void> | void = () => undefined;

    async generateImages(generationId: string, request: ImageRequest): Promise<StoredOutput[]> {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        const call = this.calls.push({ generationId, request });
        await this.gate;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await this.behaviour(call);
        const outputs: StoredOutput[] = [];
        for (let index = 0; index < request.imageCount; index += 1) outputs.push(await storeImage(generationId, index, png));
        return outputs;
      } finally {
        this.active -= 1;
      }
    }
    async checkSession(): Promise<boolean> {
      assert.equal(this.active, 0, "checkSession ran during a generation");
      return this.sessionResult;
    }
    async close(): Promise<void> {}
  }

  async function settled(manager: JobManager, id: string): Promise<GenerationJob> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const job = manager.get(id);
      assert.ok(job, "job exists");
      if (job.status !== "QUEUING" && job.status !== "RUNNING") return job;
      assert.ok(Date.now() < deadline, `job stuck in ${job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("completes a job and persists a reloadable manifest", async () => {
    const provider = new FakeProvider();
    const manager = new JobManager(provider, options);
    const queued = await manager.submit("chatgpt-web", args({ image_count: 2 }), "trace-1");
    assert.equal(queued.status, "QUEUING");
    const job = await settled(manager, queued.generationId);
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.taskTraceId, "trace-1");
    assert.equal(job.outputs?.length, 2);
    assert.equal(job.request, undefined);
    assert.equal(provider.calls[0].request.imageCount, 2);
    const reloaded = await loadPersistedJob(job.generationId);
    assert.ok(reloaded);
    assert.equal(reloaded.status, "COMPLETED");
    assert.equal(reloaded.taskTraceId, "trace-1");
    assert.deepEqual(reloaded.outputs?.map((o) => [o.index, o.filename, o.mimeType, o.width, o.height]), job.outputs?.map((o) => [o.index, o.filename, "image/png", 32, 32]));
    assert.equal(manager.status().running, false);
  });

  it("runs generations strictly one at a time and in order", async () => {
    const provider = new FakeProvider();
    const manager = new JobManager(provider, { ...options, maxQueueLength: 5 });
    const jobs = await Promise.all([1, 2, 3].map(() => manager.submit("chatgpt-web", args())));
    assert.equal(manager.get(jobs[2].generationId)?.queuePosition, 3);
    const done = await Promise.all(jobs.map((job) => settled(manager, job.generationId)));
    assert.deepEqual(done.map((job) => job.status), ["COMPLETED", "COMPLETED", "COMPLETED"]);
    assert.equal(provider.maxActive, 1);
    assert.deepEqual(provider.calls.map((call) => call.generationId), jobs.map((job) => job.generationId));
  });

  it("opens the circuit on a usage limit, failing queued jobs and rejecting new submits", async () => {
    const provider = new FakeProvider();
    provider.behaviour = () => { throw new UsageLimitReached("You've hit the plus plan limit"); };
    const manager = new JobManager(provider, options);
    const [a, b] = await Promise.all([manager.submit("chatgpt-web", args()), manager.submit("chatgpt-web", args())]);
    const [first, second] = await Promise.all([settled(manager, a.generationId), settled(manager, b.generationId)]);
    assert.equal(first.status, "FAILED");
    assert.equal(first.error?.code, "USAGE_LIMIT_REACHED");
    assert.equal(first.error?.retryable, true);
    assert.equal(second.status, "FAILED");
    assert.equal(second.error?.code, "USAGE_LIMIT_REACHED");
    assert.ok(second.error?.retryAfter);
    assert.equal(provider.calls.length, 1, "second job never reached the provider");
    await assert.rejects(manager.submit("chatgpt-web", args()), /^Error: USAGE_LIMIT_REACHED:/);
    assert.equal((manager.status().circuit as { reason: string }).reason, "usage_limit");
  });

  it("maps SessionNotReady to SESSION_NOT_READY and opens a session circuit", async () => {
    const provider = new FakeProvider();
    provider.behaviour = () => { throw new SessionNotReady(); };
    const manager = new JobManager(provider, options);
    const job = await settled(manager, (await manager.submit("chatgpt-web", args())).generationId);
    assert.equal(job.status, "FAILED");
    assert.equal(job.error?.code, "SESSION_NOT_READY");
    assert.equal(job.error?.retryable, false);
    await assert.rejects(manager.submit("chatgpt-web", args()), /^Error: SESSION_NOT_READY:/);
    assert.deepEqual((manager.status().session as { loggedIn?: boolean }).loggedIn, false);
    // A successful session check closes the session circuit.
    assert.equal(await manager.checkSession(), true);
    await assert.doesNotReject(manager.submit("chatgpt-web", args()));
  });

  it("records ordinary failures without opening the circuit", async () => {
    const provider = new FakeProvider();
    provider.behaviour = (call) => { if (call === 1) throw new ContentPolicyBlocked("refused"); };
    const manager = new JobManager(provider, options);
    const a = await settled(manager, (await manager.submit("chatgpt-web", args())).generationId);
    assert.equal(a.error?.code, "CONTENT_POLICY_BLOCKED");
    const b = await settled(manager, (await manager.submit("chatgpt-web", args())).generationId);
    assert.equal(b.status, "COMPLETED");
  });

  it("rejects with QUEUE_FULL when too many generations wait", async () => {
    let release!: () => void;
    const provider = new FakeProvider();
    provider.gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new JobManager(provider, options);
    const a = await manager.submit("chatgpt-web", args());
    const b = await manager.submit("chatgpt-web", args());
    await assert.rejects(manager.submit("chatgpt-web", args()), /^Error: QUEUE_FULL:/);
    release();
    await settled(manager, a.generationId);
    await settled(manager, b.generationId);
  });

  it("resolves generation_id references to base64 for the provider", async () => {
    const provider = new FakeProvider();
    const manager = new JobManager(provider, options);
    const source = await settled(manager, (await manager.submit("chatgpt-web", args())).generationId);
    const derived = await manager.submit("chatgpt-web", args({ reference_images: [{ generation_id: source.generationId, index: 0 }] }));
    await settled(manager, derived.generationId);
    const references = provider.calls[1].request.references;
    assert.equal(references.length, 1);
    assert.equal(references[0].mime_type, "image/png");
    assert.ok(Buffer.from(references[0].base64, "base64").equals(png));
  });

  it("rejects bad generation references", async () => {
    const manager = new JobManager(new FakeProvider(), options);
    await assert.rejects(manager.submit("chatgpt-web", args({ reference_images: [{ generation_id: randomUUID(), index: 0 }] })), /^Error: REFERENCE_GENERATION_NOT_FOUND:/);
    const source = await settled(manager, (await manager.submit("chatgpt-web", args())).generationId);
    await assert.rejects(manager.submit("chatgpt-web", args({ reference_images: [{ generation_id: source.generationId, index: 3 }] })), /^Error: REFERENCE_INDEX_OUT_OF_RANGE:/);
  });

  it("passes inline references through untouched", async () => {
    const provider = new FakeProvider();
    const manager = new JobManager(provider, options);
    const inline = { base64: png.toString("base64"), mime_type: "image/png" as const };
    await settled(manager, (await manager.submit("chatgpt-web", args({ reference_images: [inline] }))).generationId);
    assert.deepEqual(provider.calls[0].request.references, [inline]);
  });

  it("checkSession goes through the queue, after a running generation", async () => {
    const provider = new FakeProvider();
    const manager = new JobManager(provider, options);
    const job = await manager.submit("chatgpt-web", args());
    provider.sessionResult = false;
    assert.equal(await manager.checkSession(), false); // asserts inside the fake that nothing was active
    assert.equal(manager.get(job.generationId)?.status, "COMPLETED");
    assert.equal((manager.status().session as { loggedIn?: boolean }).loggedIn, false);
  });
});

describe("outputPayload", () => {
  const secret = "s".repeat(40);
  let previous: string | undefined;
  before(() => { previous = process.env.PUBLIC_MEDIA_SIGNING_SECRET; process.env.PUBLIC_MEDIA_SIGNING_SECRET = secret; });
  after(() => { if (previous === undefined) delete process.env.PUBLIC_MEDIA_SIGNING_SECRET; else process.env.PUBLIC_MEDIA_SIGNING_SECRET = previous; });

  it("builds signed and direct URLs and includes base64 only on request", async () => {
    const png = makePng(20, 10);
    const id = randomUUID();
    const stored = await storeImage(id, 0, png);
    const [plain] = await outputPayload([stored], "https://mcp.example.test/");
    assert.equal(plain.index, 0);
    assert.equal(plain.mimeType, "image/png");
    assert.equal(plain.sizeBytes, png.length);
    assert.equal(plain.width, 20);
    assert.equal(plain.height, 10);
    assert.equal(plain.downloadUrl, `https://mcp.example.test/media/${id}-0.png`);
    assert.match(String(plain.publicUrl), new RegExp(`^https://mcp\\.example\\.test/public-media/${id}-0\\.png\\?expires=\\d{10}&signature=[A-Za-z0-9_-]{43}$`));
    assert.ok(!Number.isNaN(Date.parse(String(plain.publicUrlExpiresAt))));
    assert.equal("base64" in plain, false);

    const [inline] = await outputPayload([stored], "https://mcp.example.test", true);
    assert.equal(inline.base64, png.toString("base64"));
  });
});
