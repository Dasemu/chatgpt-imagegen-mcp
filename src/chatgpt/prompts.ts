export const ASPECT_RATIOS = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

const ORIENTATION: Record<string, string> = {
  "1:1": "square", "2:3": "portrait", "3:4": "portrait", "4:5": "portrait", "9:16": "vertical",
  "3:2": "landscape", "4:3": "landscape", "5:4": "landscape", "16:9": "widescreen landscape", "21:9": "ultra-wide landscape",
};

/** Wraps the caller's prompt so ChatGPT generates directly instead of chatting about it. */
export function buildImageRequest(prompt: string, aspectRatio: string, referenceCount: number): string {
  const instructions = [
    "Generate an image with the prompt below. Do not comment on it, do not rewrite it and do not ask me any questions: create exactly one image right away, at the highest quality available.",
  ];
  if (aspectRatio !== "auto") instructions.push(`The image must use a ${aspectRatio} aspect ratio (${ORIENTATION[aspectRatio] ?? "custom"} format).`);
  if (referenceCount > 0) {
    instructions.push(referenceCount === 1
      ? "Use the attached image as the reference described in the prompt."
      : `Use the ${referenceCount} attached images as the references described in the prompt.`);
  }
  return `${instructions.join(" ")}\n\n${prompt.trim()}`;
}
