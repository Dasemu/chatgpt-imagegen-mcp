import type { Page } from "playwright";
import { imageDimensions } from "../image.js";
import { audit } from "../log.js";
import { removeOutputs, storeImage } from "../media.js";
import type { ImageRequest, StoredOutput } from "../types.js";
import { BrowserSession } from "./browser.js";
import {
  attachReferences, Diagnostics, downloadImage, imageSources, isLoggedIn, openNewChat, sendMessage, waitForGeneratedImage, waitForTurnComplete,
} from "./client.js";
import { loadChatGptConfig, type ChatGptConfig } from "./config.js";
import { ImageGenerationError, IN_SERVER_RETRY_CODES, isBrowserCrash, toJobError, TurnTimedOut } from "./errors.js";
import { buildImageRequest } from "./prompts.js";

export const MIN_IMAGE_BYTES = 20_000;

export interface ImageProvider {
  generateImages(generationId: string, request: ImageRequest): Promise<StoredOutput[]>;
  checkSession(): Promise<boolean>;
  close(): Promise<void>;
}

export class ChatGptImageProvider implements ImageProvider {
  private readonly browser: BrowserSession;
  private readonly diagnostics: Diagnostics;

  constructor(private readonly config: ChatGptConfig = loadChatGptConfig()) {
    this.browser = new BrowserSession(config);
    this.diagnostics = new Diagnostics(config.diagnosticsDir, config.maxDiagnostics);
  }

  /** One new chat per image: a fresh thread keeps earlier images out of the DOM and out of the context. */
  async generateImages(generationId: string, request: ImageRequest): Promise<StoredOutput[]> {
    const outputs: StoredOutput[] = [];
    try {
      for (let index = 0; index < request.imageCount; index += 1) {
        const started = Date.now();
        const image = await this.generateWithRetries(generationId, index, request);
        outputs.push(await storeImage(generationId, index, image));
        audit("chatgpt_image_generated", { generationId, index, sizeBytes: image.length, durationMs: Date.now() - started });
      }
      return outputs;
    } catch (error) {
      await removeOutputs(outputs);
      throw error;
    } finally {
      this.browser.release();
    }
  }

  async checkSession(): Promise<boolean> {
    try {
      const page = await this.browser.page();
      await page.goto(this.config.url, { timeout: 60_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (await isLoggedIn(page)) return true;
        await page.waitForTimeout(2000);
      }
      return false;
    } finally {
      this.browser.release();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  /** Transient failures get another attempt in a fresh chat; limits, logins and refusals do not. */
  private async generateWithRetries(generationId: string, index: number, request: ImageRequest): Promise<Buffer> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.generateOne(await this.browser.page(), request);
      } catch (error) {
        if (attempt > this.config.retries || !isRetryableInServer(error)) {
          if (attempt > 1 && error instanceof Error) error.message += ` (after ${attempt} attempts)`;
          throw error;
        }
        const delayMs = this.config.retryDelayMs * attempt;
        audit("chatgpt_attempt_failed", { generationId, index, attempt, code: toJobError(error).code, retryInMs: delayMs });
        if (isBrowserCrash(error)) await this.browser.close();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async generateOne(page: Page, request: ImageRequest): Promise<Buffer> {
    await openNewChat(page, this.config.url, this.diagnostics);
    const baseline = await imageSources(page);
    await attachReferences(page, request.references, this.diagnostics);
    await sendMessage(page, buildImageRequest(request.prompt, request.aspectRatio, request.references.length), this.diagnostics);
    try {
      await waitForTurnComplete(page, this.config.turnTimeoutMs, this.diagnostics);
    } catch (error) {
      // A turn that never settles is acceptable when the image is already on the page.
      if (!(error instanceof TurnTimedOut)) throw error;
    }
    const src = await waitForGeneratedImage(page, baseline, this.config.imageTimeoutMs, this.diagnostics);
    const image = await downloadImage(page, src);
    if (image.length < MIN_IMAGE_BYTES) throw new ImageGenerationError(`Downloaded image is suspiciously small (${image.length} bytes)`);
    if (!imageDimensions(image)) throw new ImageGenerationError("Downloaded file is not a readable PNG, JPEG or WebP image");
    return image;
  }
}

export function isRetryableInServer(error: unknown): boolean {
  const { code } = toJobError(error);
  return IN_SERVER_RETRY_CODES.has(code) && (error instanceof ImageGenerationError || code === "BROWSER_ERROR");
}
