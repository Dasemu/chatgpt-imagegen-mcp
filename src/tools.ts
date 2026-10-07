import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MODEL, normalizeArguments, resolveModel } from "./arguments.js";
import type { JobManager } from "./jobs.js";
import { maxInlineBytes, outputExists, outputPayload } from "./media.js";
import { publicMediaTtlSeconds } from "./public-media.js";

const taskTraceIdSchema = z.string().uuid().optional().describe("Optional UUID used to group related calls.");
const referenceImageSchema = z.union([
  z.object({ generation_id: z.string().uuid(), index: z.number().int().min(0).optional() }),
  z.object({ base64: z.string().min(1), mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]) }),
]);
const argumentsSchema = z.array(z.object({
  name: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(referenceImageSchema)]),
})).describe("List of {name, value} pairs. See who_am_i for the accepted arguments.");

export function registerTools(server: McpServer, jobs: JobManager): void {
  const retentionHours = Number(process.env.MEDIA_RETENTION_HOURS) || 168;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT) || 8088}`;

  server.tool("who_am_i", "Describe the ChatGPT web image backend: model, accepted arguments, queue and session state.", {
    taskTraceId: taskTraceIdSchema,
  }, async ({ taskTraceId }) => jsonResult({
    service: "Zenvairo ChatGPT Image MCP",
    taskTraceId,
    backend: "chatgpt.com web UI automated with Playwright (unofficial; uses the logged-in account's image quota)",
    workflow: "generate_image returns a generationId immediately; poll query_tasks every 10-20 s. Jobs run one at a time and each image takes roughly 1-3 minutes plus queue time.",
    resultDelivery: {
      default: "outputs[].publicUrl (HMAC-signed, no credentials needed)",
      publicUrlTtlSeconds: publicMediaTtlSeconds(),
      inlineBase64: `query_tasks with include_base64=true, up to ${Math.floor(maxInlineBytes / 1024 / 1024)} MiB`,
    },
    generationRetentionHours: retentionHours,
    models: { image: [MODEL] },
    state: jobs.status(),
  }));

  server.tool("generate_image", "Queue an image generation on chatgpt.com and return a generationId immediately. Poll it with query_tasks.", {
    model: z.string().min(1).default(MODEL.name).describe(`Use '${MODEL.name}'.`),
    arguments: argumentsSchema,
    taskTraceId: taskTraceIdSchema,
  }, async ({ model, arguments: inputArguments, taskTraceId }) => {
    try {
      const job = await jobs.submit(resolveModel(model), normalizeArguments(inputArguments), taskTraceId);
      return jsonResult({ generationId: job.generationId, status: job.status, model: job.model, queuePosition: jobs.get(job.generationId)?.queuePosition });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.match(/^([A-Z][A-Z_]+):/)?.[1] ?? "INVALID_REQUEST";
      return jsonResult({ status: "FAILED", error: { code, message } }, true);
    }
  });

  server.tool("query_tasks", "Poll an image generation. COMPLETED results include outputs[].publicUrl (expiring signed URL) that can be passed to other tools directly.", {
    generationId: z.string().uuid(),
    taskTraceId: taskTraceIdSchema,
    include_base64: z.boolean().default(false).describe("Default false. Set true only when the image bytes are needed inline."),
  }, async ({ generationId, taskTraceId, include_base64 }) => {
    const job = jobs.get(generationId);
    if (!job) return jsonResult({ generationId, status: "FAILED", error: { code: "JOB_NOT_FOUND", message: "Unknown or expired generationId", retryable: false } }, true);
    if (taskTraceId && job.taskTraceId && taskTraceId !== job.taskTraceId) {
      return jsonResult({ generationId, status: "FAILED", error: { code: "TRACE_ID_MISMATCH", message: "taskTraceId does not match this generation", retryable: false } }, true);
    }
    const payload: Record<string, unknown> = {
      generationId: job.generationId, taskTraceId: job.taskTraceId, status: job.status, model: job.model,
      ...(job.queuePosition ? { queuePosition: job.queuePosition } : {}),
      createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt,
    };
    if (job.status === "FAILED") payload.error = job.error;
    if (job.status === "COMPLETED" && job.outputs) {
      if (!(await Promise.all(job.outputs.map(outputExists))).every(Boolean)) {
        return jsonResult({ ...payload, status: "FAILED", error: { code: "MEDIA_EXPIRED", message: "Generated media is no longer available", retryable: false } }, true);
      }
      payload.outputs = await outputPayload(job.outputs, publicBaseUrl, include_base64);
    }
    return jsonResult(payload, job.status === "FAILED");
  });

  server.tool("check_session", "Open chatgpt.com with the server's browser profile and report whether it is logged in. Waits for any running generation first.", {
    taskTraceId: taskTraceIdSchema,
  }, async ({ taskTraceId }) => {
    try {
      const loggedIn = await jobs.checkSession();
      return jsonResult({ taskTraceId, loggedIn, ...(loggedIn ? {} : { action: "An operator must stop the service and run `npm run login` (see docs/chatgpt-session.md)." }) }, !loggedIn);
    } catch (error) {
      return jsonResult({ taskTraceId, loggedIn: false, error: { code: "BROWSER_ERROR", message: error instanceof Error ? error.message : String(error) } }, true);
    }
  });

  server.tool("get_usage", "Return process-local generation counters, queue length and circuit-breaker state.", {
    taskTraceId: taskTraceIdSchema,
  }, async ({ taskTraceId }) => jsonResult({ taskTraceId, ...jobs.usage() }));
}

function jsonResult(payload: Record<string, unknown>, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}
