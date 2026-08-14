---
description: Start the overlay bridge and work the user's UI tags continuously (fix + resolve as they tag)
---

Start the overlay tag-fixing workflow. The overlay browser extension lets the user tag UI issues on their running app; you fix each tag in this project's source and resolve it (the pin disappears in their browser).

Replace `<overlay-repo>` below with the absolute path where this repo is cloned (built once with `npm install && npm run build`).

## 1. Ensure the bridge is running

- Token file: `~/.overlay/token` (read it; call it TOKEN). Port default 8787.
- Probe: `curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/api/tags?token=TOKEN"` → `200` means a bridge is already running (another session's or a previous one) — REUSE it, do not spawn.
- If not running: spawn in background (Bash run_in_background): `node "<overlay-repo>/packages/mcp-bridge/dist/cli.js"`. Re-probe until 200 (a few seconds). If the token file didn't exist before, it does now — re-read it.
- If the extension isn't paired yet (user's overlay chip shows `⇅ off` persistently), tell them to visit `http://localhost:8787/pair` once.

## 2. Work loop

Repeat until the user says stop (/overlay-off) or the session ends:

1. `curl -s "http://127.0.0.1:8787/api/tags?token=TOKEN"` → JSON array. Work tags with `status != "resolved"`.
2. Per tag: `route` = page, `selector`/`testid`/`textHint` locate the DOM element, `component` (if present) names the React component, `note` = the requested change. If `screenshotId` present, view the element: Read `~/.overlay/screenshots/<screenshotId>.png`.
3. Find the real source in THIS project (never edit DOM/build output). Make the change the note asks for; match existing styles/tokens/patterns; keep edits minimal and scoped.
4. After each fix: `curl -s -X POST "http://127.0.0.1:8787/api/resolve?token=TOKEN" -H "Content-Type: application/json" -d "{\"id\":\"<tag id>\"}"` — the pin disappears in the user's browser.
5. To leave a note/question FOR the user on their page: POST `/api/create` with `{route, note}` (renders as a blue agent pin).
6. When no open tags remain, tell the user you're watching, then poll `/api/tags` again roughly every minute (use quiet waits, no busy-looping; batch fixes if several tags arrive together).

Report each fix in one line (tag note → file changed). Commit policy, testing, and everything else: follow this project's normal rules.
