import type { ImageMimeType } from "./types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageMime(data: Buffer): ImageMimeType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export function extensionFor(mimeType: ImageMimeType): "png" | "jpg" | "webp" {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
}

export function imageDimensions(data: Buffer): { width: number; height: number } | undefined {
  const mime = sniffImageMime(data);
  if (mime === "image/png" && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (mime === "image/jpeg") return jpegDimensions(data);
  if (mime === "image/webp") return webpDimensions(data);
  return undefined;
}

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = data.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 30) return undefined;
  const chunk = data.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  if (chunk === "VP8L") {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  return undefined;
}
