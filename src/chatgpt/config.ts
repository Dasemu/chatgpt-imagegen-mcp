import path from "node:path";

export interface ChatGptConfig {
  url: string;
  profileDir: string;
  headless: boolean;
  channel?: string;
  userAgent?: string;
  locale: string;
  turnTimeoutMs: number;
  imageTimeoutMs: number;
  retries: number;
  retryDelayMs: number;
  browserIdleCloseMs: number;
  diagnosticsDir: string;
  maxDiagnostics: number;
}

export function loadChatGptConfig(env: NodeJS.ProcessEnv = process.env): ChatGptConfig {
  return {
    url: env.CHATGPT_URL || "https://chatgpt.com/",
    profileDir: path.resolve(env.CHATGPT_PROFILE_DIR || "profiles/chatgpt"),
    headless: env.CHATGPT_HEADLESS === "true",
    channel: env.CHATGPT_BROWSER_CHANNEL || undefined,
    userAgent: env.CHATGPT_USER_AGENT || undefined,
    locale: env.CHATGPT_LOCALE || "es-ES",
    turnTimeoutMs: (Number(env.CHATGPT_TURN_TIMEOUT_SECONDS) || 600) * 1000,
    imageTimeoutMs: (Number(env.CHATGPT_IMAGE_TIMEOUT_SECONDS) || 180) * 1000,
    retries: env.CHATGPT_RETRIES === undefined || env.CHATGPT_RETRIES === "" ? 2 : Math.max(0, Math.floor(Number(env.CHATGPT_RETRIES)) || 0),
    retryDelayMs: (Number(env.CHATGPT_RETRY_DELAY_SECONDS) || 15) * 1000,
    browserIdleCloseMs: (Number(env.CHATGPT_BROWSER_IDLE_CLOSE_MINUTES) || 10) * 60 * 1000,
    diagnosticsDir: path.resolve(env.DIAGNOSTICS_DIR || "diagnostics"),
    maxDiagnostics: Number(env.MAX_DIAGNOSTICS) || 10,
  };
}
