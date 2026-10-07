import { ASPECT_RATIOS } from "./chatgpt/prompts.js";
import { sniffImageMime } from "./image.js";
import type { GenerationReferenceImage, InlineReferenceImage, ReferenceImage, ToolArgument } from "./types.js";

export const MODEL = {
  name: "chatgpt-web",
  aliases: ["chatgpt", "gpt-image", "chatgpt-image"],
  description: "Image generation through the chatgpt.com web UI (the account's current image model), driven by Playwright. One image per new chat; jobs run one at a time.",
  arguments: [
    { name: "prompt", required: true, description: "Image description, any language. Max 8000 characters." },
    { name: "aspect_ratio", required: false, default: "auto", allowedValues: [...ASPECT_RATIOS], description: "Requested in the prompt; ChatGPT honours it best-effort. 'auto' lets the model choose." },
    { name: "image_count", required: false, default: 1, minimum: 1, maximum: 4, description: "Number of images, each generated sequentially in its own chat." },
    { name: "reference_images", required: false, maximumItems: 4, format: "array of {generation_id, index?} or {base64, mime_type}", description: "Images uploaded to the chat as references (PNG, JPEG or WebP)." },
  ],
} as const;

export interface NormalizedArguments {
  prompt: string;
  aspect_ratio: string;
  image_count: number;
  reference_images?: ReferenceImage[];
}

export function resolveModel(requested: string): string {
  const normalized = requested.trim().toLowerCase();
  if (normalized === MODEL.name || (MODEL.aliases as readonly string[]).includes(normalized)) return MODEL.name;
  throw new Error(`Unknown model '${requested}'. Available: ${MODEL.name} (aliases: ${MODEL.aliases.join(", ")})`);
}

export function normalizeArguments(input: ToolArgument[]): NormalizedArguments {
  const known = new Set<string>(MODEL.arguments.map((argument) => argument.name));
  const values: Record<string, unknown> = {};
  for (const argument of input) {
    if (!known.has(argument.name)) throw new Error(`Unknown argument '${argument.name}' for model ${MODEL.name}`);
    if (Object.hasOwn(values, argument.name)) throw new Error(`Duplicate argument '${argument.name}'`);
    values[argument.name] = argument.value;
  }

  if (typeof values.prompt !== "string" || values.prompt.trim().length === 0) throw new Error("Missing required argument 'prompt' (non-empty string)");
  if (values.prompt.length > 8000) throw new Error("'prompt' must be at most 8000 characters");

  const aspectRatio = values.aspect_ratio ?? "auto";
  if (typeof aspectRatio !== "string" || !(ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    throw new Error(`Invalid 'aspect_ratio': ${JSON.stringify(aspectRatio)}. Allowed: ${ASPECT_RATIOS.join(", ")}`);
  }

  const imageCount = values.image_count ?? 1;
  if (!Number.isInteger(imageCount) || Number(imageCount) < 1 || Number(imageCount) > 4) throw new Error("'image_count' must be an integer between 1 and 4");

  return {
    prompt: values.prompt,
    aspect_ratio: aspectRatio,
    image_count: Number(imageCount),
    ...(values.reference_images !== undefined ? { reference_images: normalizeReferenceImages(values.reference_images) } : {}),
  };
}

function normalizeReferenceImages(input: unknown): ReferenceImage[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 4) {
    throw new Error("'reference_images' must be an array of 1 to 4 {base64, mime_type} or {generation_id, index?} objects");
  }
  const maxPerImageBytes = 20 * 1024 * 1024;
  return input.map((value, position): ReferenceImage => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`reference_images[${position}] must be an object`);
    const record = value as Record<string, unknown>;
    const hasInline = Object.hasOwn(record, "base64") || Object.hasOwn(record, "mime_type");
    const hasGeneration = Object.hasOwn(record, "generation_id") || Object.hasOwn(record, "index");
    if (hasInline && hasGeneration) throw new Error(`reference_images[${position}] must use either {base64, mime_type} or {generation_id, index?}, not both`);

    if (hasGeneration) {
      if (typeof record.generation_id !== "string" || !isUuid(record.generation_id)) throw new Error(`reference_images[${position}].generation_id must be a valid UUID`);
      const index = record.index ?? 0;
      if (!Number.isInteger(index) || Number(index) < 0) throw new Error(`reference_images[${position}].index must be a non-negative integer`);
      return { generation_id: record.generation_id, index: Number(index) } satisfies GenerationReferenceImage;
    }

    if (typeof record.base64 !== "string" || record.base64.length === 0) throw new Error(`reference_images[${position}].base64 must be a non-empty string`);
    let base64 = record.base64;
    let mimeType = record.mime_type;
    const dataUri = base64.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
    if (dataUri) {
      mimeType ??= dataUri[1];
      base64 = dataUri[2];
    }
    base64 = base64.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new Error(`reference_images[${position}].base64 is not valid standard base64`);
    if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
      throw new Error(`reference_images[${position}].mime_type must be image/png, image/jpeg or image/webp`);
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(base64.length * 3 / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > maxPerImageBytes) throw new Error(`reference_images[${position}] exceeds the 20 MiB per-image limit`);
    if (sniffImageMime(Buffer.from(base64.slice(0, 24), "base64")) !== mimeType) throw new Error(`reference_images[${position}] content does not match ${mimeType}`);
    return { base64, mime_type: mimeType } satisfies InlineReferenceImage;
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
