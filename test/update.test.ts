import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { RateLimiter, bearerToken, parseLastMarker, registerUpdateRoutes, tokenValid } from "../src/update.js";

const token = "t".repeat(40);

describe("tokenValid", () => {
  it("rejects missing, short and wrong tokens", () => {
    assert.equal(tokenValid(undefined, token), false);
    assert.equal(tokenValid(token, undefined), false);
    assert.equal(tokenValid("short", "short"), false);
    assert.equal(tokenValid("x".repeat(40), token), false);
    assert.equal(tokenValid(token.slice(1), token), false);
  });
  it("accepts the right token", () => {
    assert.equal(tokenValid(token, token), true);
  });
  it("parses bearer headers", () => {
    assert.equal(bearerToken("Bearer abc"), "abc");
    assert.equal(bearerToken("Basic abc"), undefined);
    assert.equal(bearerToken(undefined), undefined);
  });
});

describe("RateLimiter", () => {
  it("blocks after max hits and recovers when the window passes", () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.record("a", 0);
    limiter.record("a", 100);
    const blocked = limiter.check("a", 200);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 1);
    assert.equal(limiter.check("b", 200).allowed, true);
    assert.equal(limiter.check("a", 1001).allowed, true);
  });
});

describe("parseLastMarker", () => {
  it("reads the last line only", () => {
    assert.deepEqual(parseLastMarker("a\n[x] UPDATE_SUCCEEDED 2026-01-01T00:00:00Z\n"), { state: "succeeded", finishedAt: "2026-01-01T00:00:00Z" });
    assert.equal(parseLastMarker("UPDATE_SUCCEEDED t\nrestarting\n"), undefined);
    assert.equal(parseLastMarker("UPDATE_FAILED t")?.state, "failed");
  });
});

describe("update routes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "update-test-"));
  const script = path.join(dir, "fake-update.sh");
  let base = "";
  let server: ReturnType<express.Express["listen"]>;

  before(async () => {
    writeFileSync(script, "#!/bin/bash\necho fake-update-start\nsleep 1\necho \"UPDATE_SUCCEEDED $(date -u +%FT%TZ)\"\n");
    chmodSync(script, 0o755);
    process.env.UPDATE_SCRIPT = script;
    process.env.UPDATE_LOG_FILE = path.join(dir, "logs", "update.log");
    process.env.UPDATE_TOKEN = token;
    const app = express();
    registerUpdateRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    delete process.env.UPDATE_TOKEN;
  });

  const call = (method: string, route: string, auth?: string) => fetch(base + route, { method, headers: auth ? { Authorization: auth } : {} });

  it("returns 503 when the token is not configured", async () => {
    process.env.UPDATE_TOKEN = "short";
    assert.equal((await call("POST", "/admin/update", "Bearer short")).status, 503);
    process.env.UPDATE_TOKEN = token;
  });

  it("returns 401 for missing or wrong tokens", async () => {
    assert.equal((await call("POST", "/admin/update")).status, 401);
    assert.equal((await call("GET", "/admin/update/status", "Bearer nope")).status, 401);
  });

  it("starts an update, rejects a concurrent one and reports status", async () => {
    const started = await call("POST", "/admin/update", `Bearer ${token}`);
    assert.equal(started.status, 202);
    assert.equal(((await started.json()) as { state: string }).state, "running");
    assert.equal((await call("POST", "/admin/update", `Bearer ${token}`)).status, 409);
    for (let i = 0; i < 50; i++) {
      const status = (await (await call("GET", "/admin/update/status", `Bearer ${token}`)).json()) as { state: string; exitCode: number; logTail: string };
      if (status.state !== "running") {
        assert.equal(status.state, "succeeded");
        assert.equal(status.exitCode, 0);
        assert.match(status.logTail, /fake-update-start/);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail("update did not finish");
  });
});
