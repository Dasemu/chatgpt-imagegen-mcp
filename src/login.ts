import "dotenv/config";
import { BrowserSession } from "./chatgpt/browser.js";
import { isLoggedIn } from "./chatgpt/client.js";
import { loadChatGptConfig } from "./chatgpt/config.js";

// Opens chatgpt.com in a visible browser with the persistent profile so an operator can log in
// by hand (2FA included). The service must be stopped: Chromium locks the profile directory.
// `--check` only reports whether the profile is logged in.
const config = loadChatGptConfig();
const checkOnly = process.argv.includes("--check");
const browser = new BrowserSession(config);

try {
  const page = await browser.page(checkOnly ? config.headless : false);
  await page.goto(config.url, { timeout: 60_000, waitUntil: "domcontentloaded" });
  if (!checkOnly) console.log(`Profile: ${config.profileDir}\nLog in to chatgpt.com in the opened window. It closes by itself once the session is detected (10 min max).`);
  const attempts = checkOnly ? 5 : 200;
  let loggedIn = false;
  for (let attempt = 0; attempt < attempts && !loggedIn; attempt += 1) {
    await page.waitForTimeout(3000);
    loggedIn = await isLoggedIn(page);
  }
  console.log(loggedIn ? "Session detected: the profile is logged in." : "No logged-in session detected.");
  process.exitCode = loggedIn ? 0 : 1;
} catch (error) {
  console.error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  await browser.close();
}
