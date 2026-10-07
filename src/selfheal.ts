import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { audit, auditError } from "./log.js";

// Failures a selector patch can plausibly fix. Usage limits, lost sessions, refusals and text
// replies are excluded: no change to selectors.ts would help with those.
export const SELFHEAL_TRIGGER_CODES = new Set(["UI_CHANGED", "TURN_TIMED_OUT"]);

export interface SelfHealOptions {
  enabled: boolean;
  threshold: number;
  cooldownMs: number;
  script: string;
  logFile: string;
  diagnosticsDir: string;
}

export function selfHealOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SelfHealOptions {
  return {
    enabled: env.SELFHEAL_ENABLED === "true",
    threshold: Number(env.SELFHEAL_FAILURE_THRESHOLD) || 3,
    cooldownMs: (Number(env.SELFHEAL_COOLDOWN_HOURS) || 6) * 60 * 60 * 1000,
    script: path.resolve(env.SELFHEAL_SCRIPT || "scripts/selfheal.sh"),
    logFile: path.resolve(env.SELFHEAL_LOG_FILE || "logs/selfheal.log"),
    diagnosticsDir: path.resolve(env.DIAGNOSTICS_DIR || "diagnostics"),
  };
}

export interface SelfHealStatus {
  enabled: boolean;
  state: "idle" | "running" | "succeeded" | "failed";
  consecutiveFailures: number;
  threshold: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastExitCode: number | null;
  lastPullRequest: string | null;
  nextAllowedAt: string | null;
}

/**
 * Counts consecutive scraper-type failures and, past the threshold, runs scripts/selfheal.sh in the
 * background. The script runs codex (yolo mode) in a throwaway clone with a snapshot of the logged-in
 * profile, so it can inspect the live chatgpt.com frontend with Playwright + playwright-stealth and
 * patch src/chatgpt/. The result is a pull request for human review; nothing is deployed automatically.
 */
export class SelfHealer {
  private consecutiveFailures = 0;
  private running = false;
  private lastStartedAt = 0;
  private status: Pick<SelfHealStatus, "state" | "lastStartedAt" | "lastFinishedAt" | "lastExitCode" | "lastPullRequest"> = {
    state: "idle", lastStartedAt: null, lastFinishedAt: null, lastExitCode: null, lastPullRequest: null,
  };

  constructor(private readonly options: SelfHealOptions = selfHealOptionsFromEnv()) {}

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Returns the reason when this failure should start a self-heal run. The run is then reserved:
   * the caller prepares the profile snapshot and calls launch() (or abort() if that fails).
   */
  recordFailure(code: string): string | undefined {
    if (!SELFHEAL_TRIGGER_CODES.has(code)) return undefined;
    this.consecutiveFailures += 1;
    if (!this.options.enabled || this.consecutiveFailures < this.options.threshold) return undefined;
    if (this.running || Date.now() < this.lastStartedAt + this.options.cooldownMs) return undefined;
    this.running = true;
    this.lastStartedAt = Date.now();
    this.status = { ...this.status, state: "running", lastStartedAt: new Date(this.lastStartedAt).toISOString(), lastFinishedAt: null, lastExitCode: null };
    return `${this.consecutiveFailures} consecutive ${code} failures`;
  }

  abort(error: unknown): void {
    this.finish(null, error);
  }

  view(): SelfHealStatus {
    return {
      enabled: this.options.enabled,
      ...this.status,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.options.threshold,
      nextAllowedAt: this.lastStartedAt ? new Date(this.lastStartedAt + this.options.cooldownMs).toISOString() : null,
    };
  }

  launch(reason: string, profileSnapshot: string): void {
    audit("selfheal_started", { reason });
    let fd: number | undefined;
    try {
      mkdirSync(path.dirname(this.options.logFile), { recursive: true });
      fd = openSync(this.options.logFile, "a");
      const child = spawn("bash", [this.options.script], {
        cwd: path.resolve(path.dirname(this.options.script), ".."),
        env: { ...process.env, SELFHEAL_DIAGNOSTICS_DIR: this.options.diagnosticsDir, SELFHEAL_PROFILE_SNAPSHOT: profileSnapshot, SELFHEAL_REASON: reason },
        stdio: ["ignore", fd, fd],
      });
      child.on("error", (error) => this.finish(null, error));
      child.on("exit", (code) => this.finish(code));
    } catch (error) {
      this.finish(null, error);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private finish(exitCode: number | null, error?: unknown): void {
    if (!this.running) return;
    this.running = false;
    this.consecutiveFailures = 0;
    const pullRequest = exitCode === 0 ? lastPullRequestUrl(this.options.logFile) : null;
    this.status = {
      state: exitCode === 0 ? "succeeded" : "failed",
      lastStartedAt: this.status.lastStartedAt,
      lastFinishedAt: new Date().toISOString(),
      lastExitCode: exitCode,
      lastPullRequest: pullRequest ?? this.status.lastPullRequest,
    };
    if (error) auditError("selfheal_failed", error);
    audit("selfheal_finished", { exitCode, pullRequest });
  }
}

export function lastPullRequestUrl(logFile: string): string | null {
  try {
    const matches = [...readFileSync(logFile, "utf8").matchAll(/^SELFHEAL_PR_CREATED (\S+)/gm)];
    return matches.at(-1)?.[1] ?? null;
  } catch {
    return null;
  }
}
