import type { JobError } from "../types.js";

export class ImageGenerationError extends Error {
  constructor(message: string, readonly code = "GENERATION_FAILED") {
    super(message);
    this.name = new.target.name;
  }
}

/** The profile is not logged in. A configuration problem: stop and ask for a manual login. */
export class SessionNotReady extends ImageGenerationError {
  constructor(message = "chatgpt.com asks to log in: stop the service, run `npm run login` and start it again") {
    super(message, "SESSION_NOT_READY");
  }
}

/** chatgpt.com shows a usage/rate limit notice. Back off instead of retrying. */
export class UsageLimitReached extends ImageGenerationError {
  constructor(message = "ChatGPT reports that the usage limit has been reached") {
    super(message, "USAGE_LIMIT_REACHED");
  }
}

export class ContentPolicyBlocked extends ImageGenerationError {
  constructor(message: string) {
    super(message, "CONTENT_POLICY_BLOCKED");
  }
}

export class TurnTimedOut extends ImageGenerationError {
  constructor(message: string) {
    super(message, "TURN_TIMED_OUT");
  }
}

/** Codes worth another attempt in a fresh chat before the job is reported as failed. */
export const IN_SERVER_RETRY_CODES = new Set(["TURN_TIMED_OUT", "GENERATION_FAILED", "NO_IMAGE_RETURNED", "UI_CHANGED", "BROWSER_ERROR"]);

/** Browser-level failures after which the context should be relaunched. */
export function isBrowserCrash(error: unknown): boolean {
  return /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(error instanceof Error ? error.message : String(error));
}

export function toJobError(error: unknown): JobError {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  if (error instanceof ImageGenerationError) {
    const retryable = ["USAGE_LIMIT_REACHED", "TURN_TIMED_OUT", "GENERATION_FAILED", "NO_IMAGE_RETURNED"].includes(error.code);
    return { code: error.code, message, retryable };
  }
  if (/Timeout|net::ERR_|Target page, context or browser has been closed/i.test(message)) return { code: "BROWSER_ERROR", message, retryable: true };
  if (/Executable doesn't exist|ProcessSingleton|SingletonLock|profile.*in use/i.test(message)) return { code: "SERVER_NOT_CONFIGURED", message, retryable: false };
  return { code: "GENERATION_FAILED", message, retryable: false };
}
