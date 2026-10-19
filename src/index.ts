import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ChatGptImageProvider } from "./chatgpt/provider.js";
import { JobManager } from "./jobs.js";
import { audit, auditError } from "./log.js";
import { cleanupOrphanMedia, ensureMediaDir, isOutputFilename, mediaDir, resolvePublicOutput } from "./media.js";
import { publicMediaSigningConfigured, validatePublicMediaSignature } from "./public-media.js";
import { SelfHealer } from "./selfheal.js";
import { registerTools } from "./tools.js";
import { registerUpdateRoutes } from "./update.js";

const provider = new ChatGptImageProvider();
const jobs = new JobManager(provider, undefined, new SelfHealer());
const retentionHours = Number(process.env.MEDIA_RETENTION_HOURS) || 168;
await ensureMediaDir();
const orphanCleanup = async () => {
  const removed = await cleanupOrphanMedia(retentionHours);
  if (removed > 0) audit("orphan_media_expired", { removed, retentionHours });
};
await orphanCleanup();
await jobs.restoreCompletedJobs();
jobs.startCleanup(retentionHours);
setInterval(() => void orphanCleanup().catch((error) => auditError("orphan_media_cleanup_failed", error)), 15 * 60 * 1000).unref();

function buildServer(): McpServer {
  const server = new McpServer({ name: "chatgpt-imagegen", version: "0.1.0" });
  registerTools(server, jobs);
  return server;
}

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.json({ limit: `${Number(process.env.MAX_MCP_REQUEST_MB) || 40}mb` }));

app.get("/public-media/:filename", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const validation = validatePublicMediaSignature(req.params.filename, req.query.expires, req.query.signature);
  if (!validation.valid) {
    res.status(validation.reason === "expired" ? 410 : 403).json({ error: validation.reason === "expired" ? "url_expired" : "invalid_signature" });
    return;
  }
  const output = await resolvePublicOutput(req.params.filename);
  if (!output) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.setHeader("Content-Type", output.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(output.filename, { root: mediaDir, dotfiles: "deny", maxAge: 0 }, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "not_found" });
  });
});

registerUpdateRoutes(app);
app.use(authenticate);

app.get("/health", (_req, res) => res.json({ ok: true, service: "chatgpt-imagegen", publicMediaSigningConfigured: publicMediaSigningConfigured(), ...jobs.status() }));
app.get("/media/:filename", (req, res) => {
  if (!isOutputFilename(req.params.filename)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.sendFile(req.params.filename, { root: mediaDir, dotfiles: "deny", maxAge: 0 }, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "not_found" });
  });
});

app.post("/mcp", async (req, res) => {
  const started = Date.now();
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    audit("mcp_request", { method: req.body?.method, tool: req.body?.params?.name, durationMs: Date.now() - started, statusCode: res.statusCode });
  } catch (error) {
    auditError("mcp_request_failed", error, { method: req.body?.method, durationMs: Date.now() - started });
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: req.body?.id ?? null });
  }
});
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({ error: "Method not allowed; this stateless Streamable HTTP server accepts POST /mcp." });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = Number(process.env.PORT) || 8088;
const host = process.env.HOST || "127.0.0.1";
const httpServer = app.listen(port, host, () => audit("server_started", { host, port, endpoint: "/mcp", mediaRetentionHours: retentionHours }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    audit("server_stopping", { signal });
    httpServer.close();
    void provider.close().finally(() => process.exit(0));
  });
}

function authenticate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const required = process.env.MCP_SERVER_TOKEN;
  if (!required) {
    res.status(503).json({ error: "server_not_configured", message: "MCP_SERVER_TOKEN is required" });
    return;
  }
  const authorization = req.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const injected = req.get("x-mcp-server-token") || "";
  if (!safeEqual(required, bearer) && !safeEqual(required, injected)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
