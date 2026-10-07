import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { extensionFor, imageDimensions, sniffImageMime } from "./image.js";
import { createPublicMediaUrl } from "./public-media.js";
import type { GenerationJob, StoredOutput } from "./types.js";

export const mediaDir = path.resolve(process.env.MEDIA_DIR || "media");
export const maxInlineBytes = Math.floor((Number(process.env.MAX_INLINE_MEDIA_MB) || 25) * 1024 * 1024);
export const maxMediaBytes = Math.floor((Number(process.env.MAX_MEDIA_MB) || 50) * 1024 * 1024);
const tombstoneRetentionDays = Number(process.env.TOMBSTONE_RETENTION_DAYS) || 30;
const OUTPUT_FILENAME = /^([0-9a-f-]{36})-(\d+)\.(png|jpg|webp)$/;

export async function ensureMediaDir(): Promise<void> {
  await mkdir(mediaDir, { recursive: true });
}

export async function storeImage(generationId: string, index: number, buffer: Buffer): Promise<StoredOutput> {
  if (buffer.length === 0) throw new Error("ChatGPT returned an empty image");
  if (buffer.length > maxMediaBytes) throw new Error(`Generated image exceeds MAX_MEDIA_MB (${maxMediaBytes} bytes)`);
  const mimeType = sniffImageMime(buffer);
  if (!mimeType) throw new Error("Downloaded file is not a PNG, JPEG or WebP image");
  const filename = `${generationId}-${index}.${extensionFor(mimeType)}`;
  const outputPath = path.join(mediaDir, filename);
  await writeFile(outputPath, buffer, { mode: 0o640 });
  return {
    index, path: outputPath, filename, mimeType, sizeBytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"), ...imageDimensions(buffer),
  };
}

export async function outputPayload(outputs: StoredOutput[], publicBaseUrl: string, includeBase64 = false): Promise<Array<Record<string, unknown>>> {
  const totalBytes = outputs.reduce((sum, output) => sum + output.sizeBytes, 0);
  const inline = includeBase64 && totalBytes <= maxInlineBytes;
  const base = publicBaseUrl.replace(/\/+$/, "");
  return Promise.all(outputs.map(async (output) => ({
    index: output.index,
    mimeType: output.mimeType,
    sizeBytes: output.sizeBytes,
    sha256: output.sha256,
    ...(output.width && output.height ? { width: output.width, height: output.height } : {}),
    ...createPublicMediaUrl(output.filename, base),
    downloadUrl: `${base}/media/${encodeURIComponent(output.filename)}`,
    ...(inline ? { base64: (await readFile(output.path)).toString("base64") } : {}),
  })));
}

export function isOutputFilename(filename: string): boolean {
  return OUTPUT_FILENAME.test(filename);
}

export async function resolvePublicOutput(filename: string): Promise<StoredOutput | undefined> {
  const match = filename.match(OUTPUT_FILENAME);
  if (!match) return undefined;
  const job = await loadPersistedJob(match[1]);
  const output = job?.outputs?.find((candidate) => candidate.filename === filename && candidate.index === Number(match[2]));
  if (!output || !(await outputExists(output))) return undefined;
  return output;
}

export async function removeOutputs(outputs: StoredOutput[] | undefined): Promise<void> {
  if (!outputs) return;
  await Promise.all(outputs.map((output) => unlink(output.path).catch(() => undefined)));
}

export async function persistCompletedJob(job: GenerationJob): Promise<void> {
  if (job.status !== "COMPLETED" || !job.outputs) throw new Error("Only completed jobs with outputs can be persisted");
  const manifest = {
    version: 1,
    generationId: job.generationId,
    taskTraceId: job.taskTraceId,
    model: job.model,
    status: "COMPLETED",
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
    outputs: job.outputs.map(({ path: _path, ...output }) => output),
  };
  const target = manifestPath(job.generationId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), { mode: 0o640 });
  await rename(temporary, target);
}

export async function loadPersistedJobs(): Promise<GenerationJob[]> {
  const jobs: GenerationJob[] = [];
  for (const filename of await readdir(mediaDir)) {
    const match = filename.match(/^([0-9a-f-]{36})\.manifest\.json$/);
    if (!match) continue;
    const job = await loadPersistedJob(match[1]);
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function loadPersistedJob(generationId: string): Promise<GenerationJob | undefined> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(generationId), "utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || parsed.generationId !== generationId || parsed.status !== "COMPLETED") return undefined;
    if (!Array.isArray(parsed.outputs)) return undefined;
    const outputs: StoredOutput[] = parsed.outputs.map((value, position) => {
      if (!value || typeof value !== "object") throw new Error("Invalid persisted output");
      const output = value as Record<string, unknown>;
      const index = Number(output.index ?? position);
      const filename = String(output.filename ?? "");
      if (!Number.isInteger(index) || index < 0 || !filename.startsWith(`${generationId}-${index}.`) || !isOutputFilename(filename)) {
        throw new Error("Invalid persisted output path");
      }
      return {
        index,
        path: path.join(mediaDir, filename),
        filename,
        mimeType: String(output.mimeType),
        sizeBytes: Number(output.sizeBytes),
        sha256: String(output.sha256),
        ...(Number(output.width) > 0 && Number(output.height) > 0 ? { width: Number(output.width), height: Number(output.height) } : {}),
      };
    });
    return {
      generationId,
      taskTraceId: typeof parsed.taskTraceId === "string" ? parsed.taskTraceId : undefined,
      model: String(parsed.model),
      status: "COMPLETED",
      createdAt: String(parsed.createdAt),
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      updatedAt: String(parsed.updatedAt),
      outputs,
    };
  } catch {
    return undefined;
  }
}

export async function purgeGeneration(job: GenerationJob): Promise<void> {
  await removeOutputs(job.outputs);
  await unlink(manifestPath(job.generationId)).catch(() => undefined);
  await writeTombstone(job.generationId);
}

export async function generationWasPurged(generationId: string): Promise<boolean> {
  try {
    return (await stat(tombstonePath(generationId))).isFile();
  } catch {
    return false;
  }
}

export async function outputExists(output: StoredOutput): Promise<boolean> {
  try {
    const file = await stat(output.path);
    return file.isFile() && file.size === output.sizeBytes;
  } catch {
    return false;
  }
}

export async function cleanupOrphanMedia(retentionHours: number): Promise<number> {
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const tombstoneCutoff = Date.now() - tombstoneRetentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const filename of await readdir(mediaDir)) {
    const artifact = filename.match(/^([0-9a-f-]{36})(?:-\d+\.(?:png|jpg|webp)|\.manifest\.json)$/);
    const tombstone = filename.match(/^([0-9a-f-]{36})\.expired\.json$/);
    if (!artifact && !tombstone) continue;
    const outputPath = path.join(mediaDir, filename);
    try {
      const file = await stat(outputPath);
      if (artifact && file.mtimeMs < cutoff) {
        await unlink(outputPath);
        await writeTombstone(artifact[1]);
        removed += 1;
      } else if (tombstone && file.mtimeMs < tombstoneCutoff) {
        await unlink(outputPath);
      }
    } catch {
      // A concurrent cleanup/download may have removed the file.
    }
  }
  return removed;
}

function manifestPath(generationId: string): string {
  return path.join(mediaDir, `${generationId}.manifest.json`);
}

function tombstonePath(generationId: string): string {
  return path.join(mediaDir, `${generationId}.expired.json`);
}

async function writeTombstone(generationId: string): Promise<void> {
  await writeFile(tombstonePath(generationId), JSON.stringify({ generationId, purgedAt: new Date().toISOString() }), { mode: 0o640 });
}
