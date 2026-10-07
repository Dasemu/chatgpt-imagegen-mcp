export function audit(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event, ...fields })}\n`);
}

export function auditError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const details = errorDetails(error);
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event, ...fields, ...details })}\n`);
}

export function errorDetails(error: unknown): { errorName: string; errorMessage: string; providerStatus?: number } {
  if (error instanceof Error) {
    const status = providerStatus(error);
    return { errorName: error.name, errorMessage: error.message, ...(status ? { providerStatus: status } : {}) };
  }
  return { errorName: "UnknownError", errorMessage: String(error) };
}

export function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const candidates = [record.status, record.statusCode, record.code];
  for (const value of candidates) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}
