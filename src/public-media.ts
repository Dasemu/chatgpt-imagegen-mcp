import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

export interface SignedPublicMediaUrl {
  publicUrl: string;
  publicUrlExpiresAt: string;
}

export function publicMediaTtlSeconds(): number {
  const configured = Number(process.env.PUBLIC_MEDIA_URL_TTL_SECONDS);
  if (!Number.isInteger(configured) || configured < 60) return DEFAULT_TTL_SECONDS;
  return Math.min(configured, MAX_TTL_SECONDS);
}

export function publicMediaSigningConfigured(): boolean {
  return signingSecret().length >= 32;
}

export function createPublicMediaUrl(
  filename: string,
  publicBaseUrl: string,
  nowMs = Date.now(),
): SignedPublicMediaUrl {
  assertSafeFilename(filename);
  const secret = requireSigningSecret();
  const expires = Math.floor(nowMs / 1000) + publicMediaTtlSeconds();
  const signature = sign(filename, expires, secret);
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    publicUrl: `${base}/public-media/${encodeURIComponent(filename)}?expires=${expires}&signature=${signature}`,
    publicUrlExpiresAt: new Date(expires * 1000).toISOString(),
  };
}

export function validatePublicMediaSignature(
  filename: string,
  rawExpires: unknown,
  rawSignature: unknown,
  nowMs = Date.now(),
): { valid: true; expires: number } | { valid: false; reason: "invalid" | "expired" } {
  if (!publicMediaSigningConfigured()) return { valid: false, reason: "invalid" };
  try {
    assertSafeFilename(filename);
  } catch {
    return { valid: false, reason: "invalid" };
  }
  if (typeof rawExpires !== "string" || !/^\d{10}$/.test(rawExpires)) return { valid: false, reason: "invalid" };
  if (typeof rawSignature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rawSignature)) return { valid: false, reason: "invalid" };

  const expires = Number(rawExpires);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(expires)) return { valid: false, reason: "invalid" };
  if (expires < nowSeconds) return { valid: false, reason: "expired" };
  if (expires > nowSeconds + publicMediaTtlSeconds() + CLOCK_SKEW_SECONDS) return { valid: false, reason: "invalid" };

  const expected = Buffer.from(sign(filename, expires, requireSigningSecret()));
  const actual = Buffer.from(rawSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { valid: false, reason: "invalid" };
  return { valid: true, expires };
}

function sign(filename: string, expires: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`zenvairo-public-media-v1\n${filename}\n${expires}`, "utf8")
    .digest("base64url");
}

function signingSecret(): string {
  return process.env.PUBLIC_MEDIA_SIGNING_SECRET || "";
}

function requireSigningSecret(): string {
  const secret = signingSecret();
  if (secret.length < 32) throw new Error("PUBLIC_MEDIA_SIGNING_SECRET must contain at least 32 characters");
  return secret;
}

function assertSafeFilename(filename: string): void {
  if (!/^[0-9a-f-]{36}-\d+\.(png|jpg|webp)$/.test(filename)) throw new Error("Invalid public media filename");
}
