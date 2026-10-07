import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type express from "express";
import { audit, auditError } from "./log.js";

export type UpdateState = "idle" | "running" | "succeeded" | "failed";

export interface UpdateStatus {
  state: UpdateState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
}

const MIN_TOKEN_LENGTH = 32;
const SUCCESS_MARKER = "UPDATE_SUCCEEDED";
const FAILURE_MARKER = "UPDATE_FAILED";
const LOG_TAIL_LINES = 50;

export function tokenValid(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || expected.length < MIN_TOKEN_LENGTH || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() || undefined;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const recent = this.recent(key, now);
    if (recent.length >= this.max) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000)) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  record(key: string, now = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }

  private recent(key: string, now: number): number[] {
    const recent = (this.hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }
}

export function parseLastMarker(logText: string): { state: "succeeded" | "failed"; finishedAt: string | null } | undefined {
  const lines = logText.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const success = last.indexOf(SUCCESS_MARKER);
  if (success >= 0) return { state: "succeeded", finishedAt: last.slice(success + SUCCESS_MARKER.length).trim() || null };
  const failure = last.indexOf(FAILURE_MARKER);
  if (failure >= 0) return { state: "failed", finishedAt: last.slice(failure + FAILURE_MARKER.length).trim() || null };
  return undefined;
}

function tailLines(file: string, count: number): string[] {
  try {
    const text = readFileSync(file, "utf8");
    return text.split("\n").filter((line) => line.length > 0).slice(-count);
  } catch {
    return [];
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function registerUpdateRoutes(app: express.Express): void {
  const logFile = () => process.env.UPDATE_LOG_FILE || path.join(process.cwd(), "logs", "update.log");
  const scriptPath = () => process.env.UPDATE_SCRIPT || path.join(process.cwd(), "scripts", "update.sh");
  const maxRequests = positiveNumber(process.env.UPDATE_RATE_LIMIT_MAX, 30);
  const windowMs = positiveNumber(process.env.UPDATE_RATE_LIMIT_WINDOW_SECONDS, 900) * 1000;
  const requests = new RateLimiter(maxRequests, windowMs);
  const failures = new RateLimiter(Math.min(5, maxRequests), windowMs);

  let status: UpdateStatus = { state: "idle", startedAt: null, finishedAt: null, exitCode: null };
  try {
    const marker = parseLastMarker(readFileSync(logFile(), "utf8"));
    if (marker) status = { state: marker.state, startedAt: null, finishedAt: marker.finishedAt, exitCode: marker.state === "succeeded" ? 0 : 1 };
  } catch {
    // no previous log
  }

  const view = () => ({ ...status, logTail: tailLines(logFile(), LOG_TAIL_LINES).join("\n") });

  const guard: express.RequestHandler = (req, res, next) => {
    const expected = process.env.UPDATE_TOKEN;
    if (!expected || expected.length < MIN_TOKEN_LENGTH) {
      res.status(503).json({ error: "update_not_configured" });
      return;
    }
    const client = req.ip || "unknown";
    const limits = [requests.check(client), failures.check(client)];
    const blocked = limits.find((limit) => !limit.allowed);
    if (blocked) {
      audit("update_rate_limited", { client, path: req.path });
      res.setHeader("Retry-After", String(blocked.retryAfterSeconds));
      res.status(429).json({ error: "rate_limited", retryAfterSeconds: blocked.retryAfterSeconds });
      return;
    }
    requests.record(client);
    if (!tokenValid(bearerToken(req.header("authorization")), expected)) {
      failures.record(client);
      audit("update_auth_failed", { client, path: req.path });
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.post("/admin/update", guard, (req, res) => {
    if (status.state === "running") {
      res.status(409).json({ error: "update_already_running", ...view() });
      return;
    }
    try {
      const file = logFile();
      mkdirSync(path.dirname(file), { recursive: true });
      const script = scriptPath();
      if (!existsSync(script)) {
        res.status(500).json({ error: "update_script_missing" });
        return;
      }
      const fd = openSync(file, "a");
      const child = spawn(script, [], { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd] });
      closeSync(fd);
      status = { state: "running", startedAt: new Date().toISOString(), finishedAt: null, exitCode: null };
      audit("update_started", { client: req.ip, pid: child.pid });
      child.on("error", (error) => {
        auditError("update_spawn_failed", error);
        status = { ...status, state: "failed", finishedAt: new Date().toISOString(), exitCode: null };
      });
      child.on("exit", (code, signal) => {
        status = { ...status, state: code === 0 ? "succeeded" : "failed", finishedAt: new Date().toISOString(), exitCode: code };
        audit("update_finished", { exitCode: code, signal });
      });
      child.unref();
      res.status(202).json(view());
    } catch (error) {
      auditError("update_start_failed", error);
      res.status(500).json({ error: "update_start_failed" });
    }
  });

  app.get("/admin/update/status", guard, (_req, res) => {
    res.json(view());
  });
}
