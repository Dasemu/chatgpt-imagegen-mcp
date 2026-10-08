# Lessons

Recurring mistakes and how to avoid them. Several of these come from ZenvairoProspect's earlier chatgpt.com automation.

- **The composer is not a login signal.** chatgpt.com shows `#prompt-textarea` to logged-out guests too. Detect a login with profile and history markers, and detect logged-out state with login buttons.
- **Don't scan the whole page for limit or error texts.** The user's prompt is on the page. Check only error banners and the assistant reply.
- **The first image is not the final one.** ChatGPT renders blurred partial previews. Wait until the `src` is stable and no "creating image" text remains.
- **Uploaded references are images too.** Exclude images inside the user message, and anything present before sending.
- **Download through the browser.** CDN image URLs need the session cookies, so use `page.request.get`, not Node `fetch`.
- **One process per profile.** Chromium locks the profile directory. Stop the service before `npm run login`.
- **Don't force contradictory format rules.** Prospect rejected good images because a prompt rule and a QA aspect-ratio rule disagreed. Aspect ratio is a best-effort hint here and is not validated.
- **zsh and `git show rev:path`.** Quote the argument (`git show 'abc^:path'`), or zsh modifiers such as `:r` mangle it.
- **Take the image baseline after attaching references.** Reference thumbnails show up in the composer before sending and are not inside a user message, so a baseline taken earlier lets them pass as the generated result. The provider also rejects a download byte-identical to a reference.
