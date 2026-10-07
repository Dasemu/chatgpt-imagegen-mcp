import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { audit } from "../log.js";
import type { ChatGptConfig } from "./config.js";

/**
 * Owns the persistent Chromium profile. Chromium locks the profile directory, so only one
 * process (the server or `npm run login`) may use it at a time.
 */
export class BrowserSession {
  private context?: BrowserContext;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly config: ChatGptConfig) {}

  async page(headless = this.config.headless): Promise<Page> {
    this.clearIdleTimer();
    if (!this.context) {
      await mkdir(this.config.profileDir, { recursive: true, mode: 0o700 });
      this.context = await chromium.launchPersistentContext(this.config.profileDir, {
        headless,
        ...(this.config.channel ? { channel: this.config.channel } : {}),
        ...(this.config.userAgent ? { userAgent: this.config.userAgent } : {}),
        locale: this.config.locale,
        viewport: { width: 1440, height: 900 },
        args: ["--disable-blink-features=AutomationControlled"],
        ignoreDefaultArgs: ["--enable-automation"],
        acceptDownloads: true,
      });
      this.context.on("close", () => { this.context = undefined; });
      audit("browser_launched", { headless, channel: this.config.channel ?? "chromium" });
    }
    return this.context.pages()[0] ?? this.context.newPage();
  }

  /** Closes the browser after a quiet period so Chromium does not hold memory between jobs. */
  release(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.close(), this.config.browserIdleCloseMs);
    this.idleTimer.unref();
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    const context = this.context;
    this.context = undefined;
    if (context) {
      await context.close().catch(() => undefined);
      audit("browser_closed");
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
