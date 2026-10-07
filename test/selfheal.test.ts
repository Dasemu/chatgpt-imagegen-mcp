import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ImageGenerationError } from "../src/chatgpt/errors.js";
import type { ImageProvider } from "../src/chatgpt/provider.js";
import { JobManager, type JobManagerOptions } from "../src/jobs.js";
import { lastPullRequestUrl, parseSelfHealLog, SelfHealer, type SelfHealOptions } from "../src/selfheal.js";
import { storeImage } from "../src/media.js";
import type { GenerationJob, ImageRequest, StoredOutput } from "../src/types.js";
import { makePng } from "./helpers.js";

const tmpRoot = process.env.TMPDIR || os.tmpdir();
const tmp = (name: string) => mkdtempSync(path.join(tmpRoot, `${name}-`));
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeScript(body: string): { dir: string; script: string; logFile: string } {
  const dir = tmp("selfheal-unit");
  mkdirSync(path.join(dir, "scripts"));
  const script = path.join(dir, "scripts", "fake.sh");
  writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(script, 0o755);
  return { dir, script, logFile: path.join(dir, "logs", "selfheal.log") };
}

function healer(script: string, logFile: string, extra: Partial<SelfHealOptions> = {}): SelfHealer {
  return new SelfHealer({ enabled: true, threshold: 2, cooldownMs: 60_000, script, logFile, diagnosticsDir: path.join(tmpRoot, "diag"), ...extra });
}

async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(20);
  }
}

const OK_SCRIPT = `echo "snapshot=$SELFHEAL_PROFILE_SNAPSHOT"
echo "SELFHEAL_PR_CREATED https://git.example/x/pulls/7"`;

describe("SelfHealer", () => {
  it("never triggers when disabled", () => {
    const { script, logFile } = fakeScript("exit 0");
    const h = healer(script, logFile, { enabled: false });
    for (let i = 0; i < 5; i += 1) assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    assert.equal(h.view().state, "idle");
    assert.equal(h.view().enabled, false);
  });

  it("ignores failures a selector patch cannot fix", () => {
    const { script, logFile } = fakeScript("exit 0");
    const h = healer(script, logFile);
    for (const code of ["USAGE_LIMIT_REACHED", "SESSION_NOT_READY", "CONTENT_POLICY_BLOCKED", "NO_IMAGE_RETURNED"]) {
      assert.equal(h.recordFailure(code), undefined);
    }
    assert.equal(h.view().consecutiveFailures, 0);
    // They do not reset the streak either.
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    h.recordFailure("USAGE_LIMIT_REACHED");
    assert.match(h.recordFailure("TURN_TIMED_OUT") ?? "", /2 consecutive TURN_TIMED_OUT failures/);
  });

  it("resets the streak on success", () => {
    const { script, logFile } = fakeScript("exit 0");
    const h = healer(script, logFile);
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    h.recordSuccess();
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    assert.equal(h.view().consecutiveFailures, 1);
  });

  it("triggers once at the threshold, not while running, and respects the cooldown", async () => {
    const { script, logFile } = fakeScript("exit 0");
    const h = healer(script, logFile);
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    assert.match(h.recordFailure("TURN_TIMED_OUT") ?? "", /^2 consecutive/);
    assert.equal(h.view().state, "running");
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    h.abort(new Error("snapshot failed"));
    assert.equal(h.view().state, "failed");
    assert.equal(h.view().lastExitCode, null);
    assert.ok(h.view().nextAllowedAt);
    // Finished, but still inside the cooldown.
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
  });

  it("triggers again once the cooldown has passed", async () => {
    const { script, logFile } = fakeScript("exit 0");
    const h = healer(script, logFile, { cooldownMs: 30 });
    h.recordFailure("UI_CHANGED");
    assert.ok(h.recordFailure("UI_CHANGED"));
    h.abort(new Error("x"));
    await sleep(60);
    assert.equal(h.recordFailure("UI_CHANGED"), undefined);
    assert.ok(h.recordFailure("UI_CHANGED"));
  });

  it("launches the script, passes the snapshot and parses the pull request", async () => {
    const { script, logFile } = fakeScript(OK_SCRIPT);
    const h = healer(script, logFile);
    h.recordFailure("UI_CHANGED");
    const reason = h.recordFailure("UI_CHANGED");
    assert.ok(reason);
    h.launch(reason, "/some/chatgpt-profile-abc");
    await until(() => h.view().state !== "running", "self-heal to finish");
    const view = h.view();
    assert.equal(view.state, "succeeded");
    assert.equal(view.lastExitCode, 0);
    assert.equal(view.lastPullRequest, "https://git.example/x/pulls/7");
    assert.ok(view.lastFinishedAt);
    assert.equal(view.consecutiveFailures, 0);
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /snapshot=\/some\/chatgpt-profile-abc/);
    assert.match(log, /SELFHEAL_PR_CREATED/);
  });

  it("reports a failing script", async () => {
    const { script, logFile } = fakeScript("echo boom; exit 5");
    const h = healer(script, logFile);
    h.recordFailure("UI_CHANGED");
    h.launch(h.recordFailure("UI_CHANGED")!, "/x/chatgpt-profile-abc");
    await until(() => h.view().state !== "running", "self-heal to finish");
    assert.equal(h.view().state, "failed");
    assert.equal(h.view().lastExitCode, 5);
    assert.equal(h.view().lastPullRequest, null);
  });

  it("lastPullRequestUrl picks the last match and tolerates a missing file", () => {
    const dir = tmp("selfheal-log");
    const file = path.join(dir, "log");
    writeFileSync(file, "SELFHEAL_PR_CREATED https://a/pulls/1\nnoise\n  SELFHEAL_PR_CREATED not-at-line-start\nSELFHEAL_PR_CREATED https://a/pulls/2\n");
    assert.equal(lastPullRequestUrl(file), "https://a/pulls/2");
    assert.equal(lastPullRequestUrl(path.join(dir, "missing")), null);
  });
});

describe("parseSelfHealLog and state restore", () => {
  const logWith = (text: string) => {
    const file = path.join(tmp("selfheal-parse"), "selfheal.log");
    writeFileSync(file, text);
    return file;
  };
  const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, "Z");

  it("uses the last run only", () => {
    const file = logWith([
      "[2026-01-01T00:00:00Z] self-heal started: first",
      "SELFHEAL_PR_CREATED https://g/x/pulls/1",
      "SELFHEAL_MERGED https://g/x/pulls/1",
      "[2026-01-01T00:00:09Z] SELFHEAL_RESULT merged, deploying with scripts/update.sh (log: x)",
      "[2026-02-01T00:00:00Z] self-heal started: second",
      "[2026-02-01T00:00:05Z] SELFHEAL_RESULT codex made no changes",
      "",
    ].join("\n"));
    assert.deepEqual(parseSelfHealLog(file), { startedAt: "2026-02-01T00:00:00Z", pullRequest: null, merged: false, result: "failed" });
  });

  it("reports merged runs and their pull request", () => {
    const file = logWith([
      "[2026-01-01T00:00:00Z] self-heal started: r",
      "SELFHEAL_PR_CREATED https://g/x/pulls/42",
      "SELFHEAL_MERGED https://g/x/pulls/42",
      "[2026-01-01T00:00:09Z] SELFHEAL_RESULT merged, deploying with scripts/update.sh (log: x)",
      "",
    ].join("\n"));
    assert.deepEqual(parseSelfHealLog(file), { startedAt: "2026-01-01T00:00:00Z", pullRequest: "https://g/x/pulls/42", merged: true, result: "succeeded" });
  });

  it("classifies results", () => {
    const result = (text: string) => parseSelfHealLog(logWith(`[2026-01-01T00:00:00Z] self-heal started: r\n[2026-01-01T00:00:01Z] SELFHEAL_RESULT ${text}\n`)).result;
    assert.equal(result("pull request created"), "succeeded");
    assert.equal(result("dry run ok, nothing pushed"), "succeeded");
    assert.equal(result("pull request created (auto-merge disabled)"), "succeeded");
    assert.equal(result("verification failed"), "failed");
    assert.equal(result("merge failed, PR left open"), "failed");
    assert.equal(result("live smoke test failed, PR left open for review"), "failed");
    assert.equal(parseSelfHealLog(logWith("[2026-01-01T00:00:00Z] self-heal started: r\n")).result, null);
  });

  it("handles a missing or unrelated log", () => {
    const empty = { startedAt: null, pullRequest: null, merged: false, result: null };
    assert.deepEqual(parseSelfHealLog(path.join(tmp("selfheal-parse"), "nope.log")), empty);
    assert.deepEqual(parseSelfHealLog(logWith("random noise\n")), empty);
  });

  it("restores state and cooldown after a restart", () => {
    const started = stamp(60_000);
    const logFile = logWith(`[${started}] self-heal started: r\nSELFHEAL_PR_CREATED https://g/x/pulls/9\nSELFHEAL_MERGED https://g/x/pulls/9\n[${started}] SELFHEAL_RESULT merged, deploying with scripts/update.sh (log: x)\n`);
    const h = healer("/nonexistent/scripts/x.sh", logFile, { threshold: 1, cooldownMs: 6 * 3600_000 });
    const view = h.view();
    assert.equal(view.state, "succeeded");
    assert.equal(view.lastPullRequest, "https://g/x/pulls/9");
    assert.equal(Date.parse(view.lastStartedAt ?? ""), Date.parse(started));
    assert.ok(view.nextAllowedAt && Date.parse(view.nextAllowedAt) > Date.now() + 5 * 3600_000);
    assert.equal(h.recordFailure("UI_CHANGED"), undefined, "cooldown must survive the restart");
    assert.equal(h.view().state, "succeeded");
  });

  it("allows a run when the restored one is older than the cooldown", () => {
    const started = stamp(7 * 3600_000);
    const logFile = logWith(`[${started}] self-heal started: r\n[${started}] SELFHEAL_RESULT verification failed\n`);
    const h = healer("/nonexistent/scripts/x.sh", logFile, { threshold: 1, cooldownMs: 6 * 3600_000 });
    assert.equal(h.view().state, "failed");
    assert.ok(h.recordFailure("UI_CHANGED"));
  });
});

describe("JobManager + SelfHealer", () => {
  const options: JobManagerOptions = { minIntervalMs: 0, maxIntervalMs: 0, usageLimitCooldownMs: 60000, sessionRecheckMs: 60000, maxQueueLength: 5 };
  const png = makePng(8, 8);

  class FailingProvider implements ImageProvider {
    snapshots = 0;
    async generateImages(generationId: string, request: ImageRequest): Promise<StoredOutput[]> {
      if (request.prompt === "ok") return [await storeImage(generationId, 0, png)];
      throw new ImageGenerationError("x", "UI_CHANGED");
    }
    async checkSession(): Promise<boolean> { return true; }
    async snapshotProfile(): Promise<string> {
      this.snapshots += 1;
      return mkdtemp(path.join(tmpRoot, "chatgpt-profile-"));
    }
    async close(): Promise<void> {}
  }

  async function settled(manager: JobManager, id: string): Promise<GenerationJob> {
    let job: GenerationJob | undefined;
    await until(() => { job = manager.get(id); return !!job && job.status !== "QUEUING" && job.status !== "RUNNING"; }, `job ${id}`);
    return job!;
  }
  const args = (prompt: string) => ({ prompt, aspect_ratio: "auto", image_count: 1 });

  it("starts a self-heal after consecutive scraper failures", async () => {
    const { script, logFile } = fakeScript(OK_SCRIPT);
    const h = healer(script, logFile);
    const provider = new FailingProvider();
    const manager = new JobManager(provider, options, h);
    const first = await settled(manager, (await manager.submit("chatgpt-web", args("a"))).generationId);
    assert.equal(first.status, "FAILED");
    assert.doesNotMatch(first.error?.message ?? "", /self-heal/);
    assert.equal(provider.snapshots, 0);
    const second = await settled(manager, (await manager.submit("chatgpt-web", args("b"))).generationId);
    assert.equal(second.status, "FAILED");
    assert.match(second.error?.message ?? "", /self-heal run was started/);
    await until(() => h.view().state === "succeeded", "self-heal to succeed");
    assert.equal(provider.snapshots, 1);
    assert.equal(h.view().lastPullRequest, "https://git.example/x/pulls/7");
    assert.ok(manager.status().selfHeal);
    assert.equal(manager.status().selfHeal?.state, "succeeded");
  });

  it("a success in between resets the streak", async () => {
    const { script, logFile } = fakeScript(OK_SCRIPT);
    const h = healer(script, logFile);
    const provider = new FailingProvider();
    const manager = new JobManager(provider, options, h);
    for (const prompt of ["a", "ok", "b"]) await settled(manager, (await manager.submit("chatgpt-web", args(prompt))).generationId);
    await sleep(50);
    assert.equal(provider.snapshots, 0);
    assert.equal(h.view().state, "idle");
  });
});

// scripts/selfheal.sh end to end in dry-run mode, fully offline.
const toolsMissing = ["flock", "git"].filter((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0);

describe("scripts/selfheal.sh (offline)", { skip: toolsMissing.length ? `missing tools: ${toolsMissing.join(", ")}` : false }, () => {
  const git = (cwd: string, ...gitArgs: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...gitArgs], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${gitArgs.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };

  const CODEX_COMMON = `#!/usr/bin/env bash
set -u
[[ "$1" == "exec" && "$2" == "--dangerously-bypass-approvals-and-sandbox" ]] || { echo "bad args: $*" >&2; exit 90; }
dir=""; out=""; args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == "-C" ]] && dir="\${args[i+1]}"
  [[ "\${args[i]}" == "-o" ]] && out="\${args[i+1]}"
done
[[ -d "$dir" && -n "$out" ]] || { echo "missing -C/-o" >&2; exit 91; }
prompt="\${args[\${#args[@]}-1]}"
[[ "$prompt" != *"{{"* ]] || { echo "unsubstituted placeholder" >&2; exit 92; }
[[ "$prompt" == *"$dir"* ]] || { echo "repo path missing from prompt" >&2; exit 93; }
[[ "$prompt" == *"$SELFHEAL_PROFILE_SNAPSHOT"* ]] || { echo "profile path missing from prompt" >&2; exit 94; }
[[ -z "\${MCP_SERVER_TOKEN:-}" ]] || { echo "MCP_SERVER_TOKEN leaked" >&2; exit 95; }
`;
  const CODEX_EDIT = `echo "// healed" >> "$dir/src/chatgpt/selectors.ts"\necho "summary of changes" > "$out"\n`;

  function setup(opts: { testScript?: string } = {}) {
    const base = tmp("selfheal-e2e");
    const project = path.join(base, "project");
    mkdirSync(path.join(project, "src/chatgpt"), { recursive: true });
    mkdirSync(path.join(project, "test/fixtures"), { recursive: true });
    writeFileSync(path.join(project, "package.json"), JSON.stringify({
      name: "fake", version: "1.0.0", private: true,
      scripts: { typecheck: "exit 0", test: opts.testScript ?? "exit 0" },
    }, null, 2));
    writeFileSync(path.join(project, "package-lock.json"), JSON.stringify({
      name: "fake", version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: "fake", version: "1.0.0" } },
    }, null, 2));
    writeFileSync(path.join(project, "src/chatgpt/selectors.ts"), "export const X = 1;\n");
    writeFileSync(path.join(project, "test/fixtures/a.html"), "<html></html>\n");
    git(project, "init", "--quiet", "-b", "main");
    git(project, "add", "-A");
    git(project, "commit", "--quiet", "-m", "init");
    const bare = path.join(base, "origin.git");
    git(base, "clone", "--quiet", "--bare", project, bare);

    const root = path.join(base, "root");
    git(base, "clone", "--quiet", bare, root);
    mkdirSync(path.join(root, "scripts/selfheal"), { recursive: true });
    for (const file of ["selfheal.sh", "selfheal/prompt.md", "selfheal/requirements.txt", "selfheal/browse.py"]) {
      writeFileSync(path.join(root, "scripts", file), readFileSync(path.join(REPO_ROOT, "scripts", file)));
    }

    const venv = path.join(base, "venv");
    mkdirSync(path.join(venv, "bin"), { recursive: true });
    for (const name of ["python", "pip"]) {
      writeFileSync(path.join(venv, "bin", name), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(venv, "bin", name), 0o755);
    }
    const diag = path.join(base, "diag");
    mkdirSync(diag);
    writeFileSync(path.join(diag, "20260101-composer-not-found.html"), "<html>synthetic</html>");
    writeFileSync(path.join(diag, "20260101-composer-not-found.png"), makePng(2, 2));
    return { base, root, venv, diag, bare };
  }

  const FAKE_TEA = `#!/usr/bin/env bash
echo "$*" >> "$TEA_LOG"
if [[ "$1 $2" == "pr create" ]]; then echo "https://git.example/org/repo/pulls/42"; exit 0; fi
if [[ "$1 $2" == "pr merge" ]]; then [[ -z "\${TEA_MERGE_FAIL:-}" ]] && exit 0 || { echo "merge refused" >&2; exit 1; }; fi
exit 2
`;

  function run(codexBody: string, opts: { testScript?: string; env?: Record<string, string>; live?: boolean } = {}) {
    const env = setup(opts);
    const binDir = path.join(env.base, "bin");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "tea"), FAKE_TEA);
    chmodSync(path.join(binDir, "tea"), 0o755);
    const teaLog = path.join(env.base, "tea.log");
    const updateLog = path.join(env.base, "update.log");
    writeFileSync(path.join(env.root, "scripts/update.sh"), "#!/usr/bin/env bash\necho \"UPDATE_SUCCEEDED fake\"\n");
    const codex = path.join(env.base, "codex");
    writeFileSync(codex, CODEX_COMMON + codexBody);
    chmodSync(codex, 0o755);
    const snapshot = mkdtempSync(path.join(env.base, "chatgpt-profile-"));
    writeFileSync(path.join(snapshot, "Cookies"), "secret");
    const result = spawnSync("bash", [path.join(env.root, "scripts/selfheal.sh")], {
      cwd: env.root, encoding: "utf8", timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        TEA_LOG: teaLog,
        UPDATE_LOG_FILE: updateLog,
        SELFHEAL_SKIP_SMOKE: opts.live ? "false" : "true",
        TMPDIR: env.base,
        MCP_SERVER_TOKEN: "secret",
        SELFHEAL_VENV: env.venv,
        SELFHEAL_CODEX_BIN: codex,
        SELFHEAL_PROFILE_SNAPSHOT: snapshot,
        SELFHEAL_DRY_RUN: opts.env?.SELFHEAL_DRY_RUN ?? "true",
        SELFHEAL_REASON: "2 consecutive UI_CHANGED failures",
        DIAGNOSTICS_DIR: env.diag,
        npm_config_offline: "true",
        npm_config_cache: path.join(env.base, "npm-cache"),
        ...opts.env,
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
    return { ...env, result, output, snapshot, teaCalls: read(teaLog), updateOutput: read(updateLog) };
  }

  it("applies codex changes, verifies and finishes without pushing", () => {
    const { result, output, snapshot, bare } = run(CODEX_EDIT);
    assert.equal(result.status, 0, output);
    assert.match(output, /SELFHEAL_RESULT dry run ok/);
    assert.match(output, /diagnostics provided: 2 files/);
    assert.match(output, /src\/chatgpt\/selectors\.ts/);
    assert.equal(existsSync(snapshot), false, "profile snapshot must be deleted");
    const branches = git(bare, "branch", "--list", "--format=%(refname:short)").split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(branches, ["main"], "dry run must not push");
  });

  it("rejects changes outside the allowed paths (exit 4)", () => {
    const { result, output, snapshot } = run(`${CODEX_EDIT}echo x > "$dir/notes.txt"\n`);
    assert.equal(result.status, 4, output);
    assert.match(output, /forbidden paths changed.*notes\.txt/);
    assert.equal(existsSync(snapshot), false);
  });

  it("fails when codex changes nothing (exit 3)", () => {
    const { result, output } = run(`echo "nothing to do" > "$out"\n`);
    assert.equal(result.status, 3, output);
    assert.match(output, /codex made no changes/);
  });

  it("fails when verification fails (exit 5)", () => {
    const { result, output } = run(CODEX_EDIT, { testScript: "exit 1" });
    assert.equal(result.status, 5, output);
    assert.match(output, /verification failed/);
  });

  it("fails the dry run when the live smoke test fails (exit 8)", () => {
    const { result, output, snapshot } = run(CODEX_EDIT, { live: true });
    assert.equal(result.status, 8, output);
    assert.match(output, /live smoke test FAILED/);
    assert.match(output, /live smoke test failed/);
    assert.equal(existsSync(snapshot), false);
  });

  const LIVE = { env: { SELFHEAL_DRY_RUN: "false" } };
  const branchesOf = (bare: string) => git(bare, "branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean);

  it("pushes, opens a PR, merges it and hands over to update.sh", () => {
    const { result, output, snapshot, bare, teaCalls, updateOutput } = run(CODEX_EDIT, LIVE);
    assert.equal(result.status, 0, output);
    assert.match(output, /SELFHEAL_PR_CREATED https:\/\/git\.example\/org\/repo\/pulls\/42/);
    assert.match(output, /SELFHEAL_MERGED https:\/\/git\.example\/org\/repo\/pulls\/42/);
    assert.match(teaCalls, /^pr create --head selfheal\/chatgpt-scraper-\d{8}-\d{6} --base main /m);
    assert.match(teaCalls, /^pr merge 42 --style squash /m);
    assert.match(updateOutput, /UPDATE_SUCCEEDED fake/);
    assert.ok(branchesOf(bare).some((b) => b.startsWith("selfheal/chatgpt-scraper-")), "branch pushed to origin");
    assert.equal(existsSync(snapshot), false);
  });

  it("exits 7 and skips the update when the merge fails", () => {
    const { result, output, teaCalls, updateOutput, snapshot } = run(CODEX_EDIT, { env: { ...LIVE.env, TEA_MERGE_FAIL: "1" } });
    assert.equal(result.status, 7, output);
    assert.match(output, /merge failed, PR left open/);
    assert.match(teaCalls, /^pr merge 42/m);
    assert.doesNotMatch(output, /SELFHEAL_MERGED/);
    assert.equal(updateOutput, "");
    assert.equal(existsSync(snapshot), false);
  });

  it("does not merge when SELFHEAL_AUTO_MERGE=false", () => {
    const { result, output, teaCalls, updateOutput } = run(CODEX_EDIT, { env: { ...LIVE.env, SELFHEAL_AUTO_MERGE: "false" } });
    assert.equal(result.status, 0, output);
    assert.match(output, /SELFHEAL_PR_CREATED/);
    assert.doesNotMatch(teaCalls, /pr merge/);
    assert.equal(updateOutput, "");
  });

  it("merges but does not update when SELFHEAL_AUTO_UPDATE=false", () => {
    const { result, output, teaCalls, updateOutput } = run(CODEX_EDIT, { env: { ...LIVE.env, SELFHEAL_AUTO_UPDATE: "false" } });
    assert.equal(result.status, 0, output);
    assert.match(output, /SELFHEAL_MERGED/);
    assert.match(teaCalls, /^pr merge 42/m);
    assert.equal(updateOutput, "");
  });

  it("leaves the PR open and exits 8 when the live smoke test fails", () => {
    const { result, output, teaCalls, updateOutput } = run(CODEX_EDIT, { live: true, env: LIVE.env });
    assert.equal(result.status, 8, output);
    assert.match(output, /SELFHEAL_PR_CREATED/);
    assert.match(teaCalls, /pr create/);
    assert.doesNotMatch(teaCalls, /pr merge/);
    assert.equal(updateOutput, "");
  });
});
