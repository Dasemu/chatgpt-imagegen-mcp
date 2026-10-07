#!/usr/bin/env python3
"""Inspect the live chatgpt.com frontend for self-heal runs.

Opens chatgpt.com with a copy of the logged-in profile (Playwright + playwright-stealth), optionally
sends a prompt, and writes snapshots (HTML, screenshot, and a compact JSON summary of interesting
elements) so an agent can see what changed in the DOM.

Usage:
  browse.py --profile DIR --out DIR [--url URL] [--prompt TEXT] [--attach IMAGE] [--wait SECONDS] [--every SECONDS]
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright
from playwright_stealth import Stealth

SUMMARY_JS = """
() => {
  const pick = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    testid: el.getAttribute('data-testid') || undefined,
    aria: el.getAttribute('aria-label') || undefined,
    role: el.getAttribute('role') || undefined,
    author: el.getAttribute('data-message-author-role') || undefined,
    turn: el.getAttribute('data-turn') || undefined,
    editable: el.getAttribute('contenteditable') || undefined,
    type: el.getAttribute('type') || undefined,
    accept: el.getAttribute('accept') || undefined,
    disabled: el.disabled || undefined,
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120) || undefined,
  });
  const selector = '[data-testid],[aria-label],[data-message-author-role],[data-turn],[contenteditable],input,textarea,button,[role=alert],[role=dialog]';
  const elements = Array.from(document.querySelectorAll(selector)).slice(0, 600).map(pick);
  const images = Array.from(document.querySelectorAll('img')).map((img) => ({
    src: (img.currentSrc || img.src).slice(0, 160),
    alt: img.alt || undefined,
    width: img.naturalWidth,
    height: img.naturalHeight,
    complete: img.complete,
    inUser: !!img.closest('[data-message-author-role="user"],[data-turn="user"]'),
    inAssistant: !!img.closest('[data-message-author-role="assistant"],[data-turn="assistant"]'),
  }));
  return { url: location.href, title: document.title, elements, images };
}
"""


def snapshot(page: Page, out: Path, label: str) -> None:
    base = out / f"{time.strftime('%H%M%S')}-{label}"
    base.with_suffix(".html").write_text(page.content(), encoding="utf-8")
    page.screenshot(path=str(base.with_suffix(".png")), full_page=False)
    base.with_suffix(".json").write_text(json.dumps(page.evaluate(SUMMARY_JS), indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"snapshot {base}")


def first_visible(page: Page, selectors: list[str]):
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if locator.count() > 0 and locator.is_visible():
                return locator
        except Exception:
            continue
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", required=True, help="Copy of the logged-in Chromium profile (never the live one)")
    parser.add_argument("--out", required=True, help="Directory for snapshots")
    parser.add_argument("--url", default=os.environ.get("CHATGPT_URL", "https://chatgpt.com/"))
    parser.add_argument("--prompt", help="Message to send (e.g. a harmless image request)")
    parser.add_argument("--attach", help="Image file to upload before sending")
    parser.add_argument("--wait", type=int, default=0, help="Seconds to keep observing after sending")
    parser.add_argument("--every", type=int, default=20, help="Seconds between snapshots while observing")
    parser.add_argument("--headless", action="store_true", default=os.environ.get("CHATGPT_HEADLESS") == "true")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with Stealth().use_sync(sync_playwright()) as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=args.profile,
            headless=args.headless,
            locale=os.environ.get("CHATGPT_LOCALE", "es-ES"),
            viewport={"width": 1440, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
            ignore_default_args=["--enable-automation"],
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(args.url, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(4000)
            snapshot(page, out, "loaded")
            if args.attach:
                file_input = page.locator('input[type="file"]').first
                file_input.set_input_files(args.attach)
                page.wait_for_timeout(5000)
                snapshot(page, out, "attached")
            if args.prompt:
                composer = first_visible(page, ["#prompt-textarea", '[contenteditable="true"]', "textarea"])
                if composer is None:
                    print("composer not found with generic selectors; inspect the 'loaded' snapshot")
                else:
                    composer.click()
                    page.keyboard.insert_text(args.prompt)
                    page.wait_for_timeout(800)
                    snapshot(page, out, "typed")
                    page.keyboard.press("Enter")
            deadline = time.monotonic() + args.wait
            step = 0
            while time.monotonic() < deadline:
                page.wait_for_timeout(max(1, args.every) * 1000)
                step += 1
                snapshot(page, out, f"t{step * args.every:04d}s")
        finally:
            context.close()


if __name__ == "__main__":
    main()
