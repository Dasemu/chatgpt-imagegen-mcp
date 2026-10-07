import "dotenv/config";
import { randomUUID } from "node:crypto";
import { ChatGptImageProvider } from "./chatgpt/provider.js";
import { ensureMediaDir } from "./media.js";

// Live end-to-end check: generates one real image on chatgpt.com with the configured profile.
// Used by scripts/selfheal.sh before auto-merging a patch. Consumes one image of the account quota.
// Exit codes: 0 image generated, 1 generation failed.
const prompt = process.env.SMOKE_PROMPT || "A simple red cube on a plain white background, studio lighting";
const provider = new ChatGptImageProvider();

try {
  await ensureMediaDir();
  const [output] = await provider.generateImages(randomUUID(), { prompt, aspectRatio: "1:1", imageCount: 1, references: [] });
  console.log(`SMOKE_OK ${output.filename} ${output.mimeType} ${output.width ?? "?"}x${output.height ?? "?"} ${output.sizeBytes} bytes`);
} catch (error) {
  console.error(`SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await provider.close();
}
