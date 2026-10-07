import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { NormalizedArguments } from "./arguments.js";
import { ImageGenerationError, SessionNotReady, UsageLimitReached } from "./chatgpt/errors.js";
import type { ImageProvider } from "./chatgpt/provider.js";
import { audit, auditError } from "./log.js";
import { generationWasPurged, loadPersistedJob, loadPersistedJobs, outputExists, persistCompletedJob, purgeGeneration } from "./media.js";
import type { GenerationJob, InlineReferenceImage, JobError, ReferenceImage } from "./types.js";

export interface JobManagerOptions {
  minIntervalMs: number;
  maxIntervalMs: number;
  usageLimitCooldownMs: number;
  sessionRecheckMs: number;
  maxQueueLength: number;
}

export function jobManagerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): JobManagerOptions {
  const minIntervalMs = (Number(env.CHATGPT_MIN_INTERVAL_SECONDS) || 30) * 1000;
  return {
    minIntervalMs,
    maxIntervalMs: Math.max(minIntervalMs, (Number(env.CHATGPT_MAX_INTERVAL_SECONDS) || 90) * 1000),
    usageLimitCooldownMs: (Number(env.CHATGPT_USAGE_LIMIT_COOLDOWN_MINUTES) || 60) * 60 * 1000,
    sessionRecheckMs: (Number(env.CHATGPT_SESSION_RECHECK_MINUTES) || 5) * 60 * 1000,
    maxQueueLength: Number(env.MAX_QUEUE_LENGTH) || 20,
  };
}

interface Circuit {
  reason: "usage_limit" | "session";
  until: number;
  message: string;
}

type Task =
  | { kind: "generate"; job: GenerationJob }
  | { kind: "session_check"; resolve: (loggedIn: boolean) => void; reject: (error: unknown) => void };

/**
 * Serial queue: one Chromium profile means one generation at a time. Adds random pacing between
 * generations and a circuit breaker for usage limits and lost sessions.
 */
export class JobManager {
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly queue: Task[] = [];
  private draining = false;
  private lastFinishedAt = 0;
  private circuit?: Circuit;
  private session: { loggedIn?: boolean; checkedAt?: string } = {};

  constructor(private readonly provider: ImageProvider, private readonly options: JobManagerOptions = jobManagerOptionsFromEnv()) {}

  async submit(model: string, args: NormalizedArguments, taskTraceId?: string): Promise<GenerationJob> {
    this.assertAccepting();
    if (this.pendingGenerations() >= this.options.maxQueueLength) {
      throw new Error(`QUEUE_FULL: ${this.options.maxQueueLength} generations are already waiting; try again later`);
    }
    const references = await this.resolveReferences(args.reference_images);
    const now = new Date().toISOString();
    const job: GenerationJob = {
      generationId: randomUUID(), taskTraceId, model, status: "QUEUING", createdAt: now, updatedAt: now,
      request: { prompt: args.prompt, aspectRatio: args.aspect_ratio, imageCount: args.image_count, references },
    };
    this.jobs.set(job.generationId, job);
    this.queue.push({ kind: "generate", job });
    audit("generation_queued", { generationId: job.generationId, taskTraceId, model, imageCount: args.image_count, referenceImageCount: references.length, queueLength: this.queue.length });
    setImmediate(() => void this.drain());
    return job;
  }

  /** Runs through the queue so it never touches the browser while a generation is in progress. */
  checkSession(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "session_check", resolve, reject });
      setImmediate(() => void this.drain());
    });
  }

  get(generationId: string): GenerationJob | undefined {
    const job = this.jobs.get(generationId);
    if (job?.status === "QUEUING") {
      job.queuePosition = this.queue.filter((task) => task.kind === "generate").findIndex((task) => task.kind === "generate" && task.job === job) + 1;
    } else if (job) {
      job.queuePosition = undefined;
    }
    return job;
  }

  status(): Record<string, unknown> {
    const circuit = this.openCircuit();
    return {
      queueLength: this.pendingGenerations(),
      running: [...this.jobs.values()].some((job) => job.status === "RUNNING"),
      session: this.session,
      circuit: circuit ? { reason: circuit.reason, retryAfter: new Date(circuit.until).toISOString(), message: circuit.message } : null,
    };
  }

  async restoreCompletedJobs(): Promise<number> {
    const restored = await loadPersistedJobs();
    for (const job of restored) this.jobs.set(job.generationId, job);
    if (restored.length > 0) audit("completed_jobs_restored", { count: restored.length });
    return restored.length;
  }

  usage(): Record<string, unknown> {
    const jobs = [...this.jobs.values()];
    return {
      scope: "current process plus completed generations restored from retained disk manifests",
      quotaAvailable: false,
      quotaMessage: "chatgpt.com does not expose remaining image quota; a usage-limit notice opens the circuit breaker instead.",
      jobsTracked: jobs.length,
      jobsCompleted: jobs.filter((job) => job.status === "COMPLETED").length,
      jobsFailed: jobs.filter((job) => job.status === "FAILED").length,
      jobsInProgress: jobs.filter((job) => job.status === "QUEUING" || job.status === "RUNNING").length,
      imagesGenerated: jobs.reduce((sum, job) => sum + (job.outputs?.length ?? 0), 0),
      ...this.status(),
    };
  }

  startCleanup(retentionHours: number): NodeJS.Timeout {
    const interval = setInterval(() => void this.cleanup(retentionHours), 15 * 60 * 1000);
    interval.unref();
    return interval;
  }

  async cleanup(retentionHours: number): Promise<void> {
    const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if ((job.status === "COMPLETED" || job.status === "FAILED") && new Date(job.updatedAt).getTime() < cutoff) {
        await purgeGeneration(job);
        this.jobs.delete(id);
        audit("generation_expired", { generationId: id, retentionHours });
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let task = this.queue[0]; task; task = this.queue[0]) {
        if (task.kind === "session_check") {
          this.queue.shift();
          await this.runSessionCheck(task);
          continue;
        }
        const circuit = this.openCircuit();
        if (circuit) {
          this.queue.shift();
          const jobError = circuitError(circuit);
          this.fail(task.job, new Error(jobError.message), jobError);
          continue;
        }
        await this.pace();
        this.queue.shift();
        await this.run(task.job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async pace(): Promise<void> {
    if (this.lastFinishedAt === 0) return;
    const { minIntervalMs, maxIntervalMs } = this.options;
    const interval = minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
    const wait = this.lastFinishedAt + interval - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private async run(job: GenerationJob): Promise<void> {
    if (!job.request) return this.fail(job, new Error("Job has no request"));
    job.status = "RUNNING"; job.startedAt = new Date().toISOString(); job.updatedAt = job.startedAt;
    audit("generation_started", { generationId: job.generationId, model: job.model });
    try {
      const outputs = await this.provider.generateImages(job.generationId, job.request);
      job.status = "COMPLETED"; job.outputs = outputs; job.completedAt = new Date().toISOString(); job.updatedAt = job.completedAt;
      job.request = undefined;
      this.session = { loggedIn: true, checkedAt: job.completedAt };
      await persistCompletedJob(job);
      audit("generation_completed", { generationId: job.generationId, outputCount: outputs.length, outputBytes: outputs.reduce((sum, output) => sum + output.sizeBytes, 0), durationMs: Date.now() - new Date(job.startedAt).getTime() });
    } catch (error) {
      this.tripCircuit(error);
      this.fail(job, error);
    } finally {
      this.lastFinishedAt = Date.now();
    }
  }

  private async runSessionCheck(task: Extract<Task, { kind: "session_check" }>): Promise<void> {
    try {
      const loggedIn = await this.provider.checkSession();
      this.session = { loggedIn, checkedAt: new Date().toISOString() };
      if (loggedIn && this.circuit?.reason === "session") this.circuit = undefined;
      audit("session_checked", { loggedIn });
      task.resolve(loggedIn);
    } catch (error) {
      auditError("session_check_failed", error);
      task.reject(error);
    }
  }

  private tripCircuit(error: unknown): void {
    let reason: Circuit["reason"] | undefined;
    let cooldown = 0;
    if (error instanceof UsageLimitReached) { reason = "usage_limit"; cooldown = this.options.usageLimitCooldownMs; }
    if (error instanceof SessionNotReady) {
      reason = "session"; cooldown = this.options.sessionRecheckMs;
      this.session = { loggedIn: false, checkedAt: new Date().toISOString() };
    }
    if (!reason) return;
    this.circuit = { reason, until: Date.now() + cooldown, message: (error as Error).message };
    audit("circuit_opened", { reason, retryAfter: new Date(this.circuit.until).toISOString() });
  }

  private openCircuit(): Circuit | undefined {
    if (this.circuit && this.circuit.until <= Date.now()) this.circuit = undefined;
    return this.circuit;
  }

  private assertAccepting(): void {
    const circuit = this.openCircuit();
    if (circuit) {
      const error = circuitError(circuit);
      throw new Error(`${error.code}: ${error.message} (retry after ${error.retryAfter})`);
    }
  }

  private pendingGenerations(): number {
    return this.queue.filter((task) => task.kind === "generate").length;
  }

  private fail(job: GenerationJob, error: unknown, jobError: JobError = toJobError(error)): void {
    job.status = "FAILED"; job.updatedAt = new Date().toISOString(); job.completedAt = job.updatedAt;
    job.request = undefined;
    job.error = jobError;
    auditError("generation_failed", error, { generationId: job.generationId, code: job.error.code, durationMs: job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : undefined });
  }

  private async resolveReferences(references: ReferenceImage[] | undefined): Promise<InlineReferenceImage[]> {
    if (!references) return [];
    const maxAggregateBytes = Math.floor((Number(process.env.MAX_REFERENCE_INPUT_MB) || 25) * 1024 * 1024);
    let aggregateBytes = 0;
    const resolved: InlineReferenceImage[] = [];
    for (const [position, reference] of references.entries()) {
      if ("base64" in reference) {
        aggregateBytes += Math.floor(reference.base64.length * 3 / 4);
        resolved.push(reference);
      } else {
        const label = `reference_images[${position}] generation_id ${reference.generation_id}`;
        let source = this.jobs.get(reference.generation_id) ?? await loadPersistedJob(reference.generation_id);
        if (!source) {
          throw new Error(await generationWasPurged(reference.generation_id) ? `REFERENCE_GENERATION_EXPIRED: ${label} has expired` : `REFERENCE_GENERATION_NOT_FOUND: ${label} does not exist`);
        }
        if (source.status !== "COMPLETED" || !source.outputs) throw new Error(`REFERENCE_GENERATION_NOT_COMPLETED: ${label} has status ${source.status}; wait for COMPLETED`);
        const output = source.outputs.find((candidate) => candidate.index === reference.index);
        if (!output) throw new Error(`REFERENCE_INDEX_OUT_OF_RANGE: ${label} has no output ${reference.index}`);
        if (!(await outputExists(output))) throw new Error(`REFERENCE_GENERATION_EXPIRED: ${label} output ${reference.index} has expired`);
        aggregateBytes += output.sizeBytes;
        resolved.push({ base64: (await readFile(output.path)).toString("base64"), mime_type: output.mimeType as InlineReferenceImage["mime_type"] });
      }
      if (aggregateBytes > maxAggregateBytes) throw new Error(`REFERENCE_INPUT_TOO_LARGE: reference_images exceed MAX_REFERENCE_INPUT_MB (${maxAggregateBytes} bytes)`);
    }
    return resolved;
  }
}

function circuitError(circuit: Circuit): JobError {
  return circuit.reason === "usage_limit"
    ? { code: "USAGE_LIMIT_REACHED", message: "ChatGPT usage limit reached; generation paused", retryable: true, retryAfter: new Date(circuit.until).toISOString() }
    : { code: "SESSION_NOT_READY", message: "The ChatGPT profile is not logged in; an operator must run `npm run login`", retryable: false, retryAfter: new Date(circuit.until).toISOString() };
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
