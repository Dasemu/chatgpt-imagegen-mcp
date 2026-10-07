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
