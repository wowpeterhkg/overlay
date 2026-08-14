# User Guide

From zero to your first agent-fixed tag. Assumes Chrome (116+), Node 18+, and — for the agent loop — Claude Code.

If you only want the concepts, read [ARCHITECTURE.md](ARCHITECTURE.md) instead. This is the hands-on version.

---

## 1. Install (once)

### Build the repo

```bash
git clone https://github.com/idNerdJacky/overlay
cd overlay
npm install
npm run build
```

### Load the extension

1. Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `packages/extension/dist-ext`

The overlay now appears on **every** `http(s)` page as a small `💬` button bottom-right. Local dev server, staging site, cloud preview — no per-site setup. (Hide it anywhere via the popup — see [Switching it off](#6-switching-it-off).)

### Install the Claude Code commands

Copy the two command files into your user-level commands folder:

```bash
cp commands/overlay-on.md commands/overlay-off.md ~/.claude/commands/
```

Then open each copy and replace `<overlay-repo>` with the absolute path of this clone. That's the whole agent setup for Claude Code — no MCP registration needed.

*(Claude Desktop / Cursor instead? Register the bridge as an MCP server: `claude mcp add overlay -- node <overlay-repo>/packages/mcp-bridge/dist/cli.js` — the four tools in the [README](../README.md#mcp-tools) appear in-session.)*

### Pair the extension with the bridge (first run only)

The bridge starts automatically when you first run `/overlay-on` (next section). On its very first run it opens `http://localhost:8787/pair` — with the extension installed, the page flips to **✓ Paired** by itself. One click of nothing; you just watch.

---

## 2. The loop, end to end

The workflow you'll actually live in:

1. **Run your app** (any dev server, any port).
2. **Open a Claude Code session in the project you want fixed** and type `/overlay-on`. It starts (or reuses) the bridge and begins watching for tags.
3. **Browse your app and tag things** (next section). Each tag = one change request.
4. The session picks tags up, **looks at the screenshot**, finds the component, **edits your source**, and resolves the tag — the pin disappears in your browser while you keep clicking around.
5. New tags any time; it keeps watching. `/overlay-off` when you're done.

No bridge/agent running? Everything still works locally — tag now, sync later, or use the **Copy** button for the manual paste-into-any-AI flow.

---

## 3. Tagging

Open the panel with the `💬` button (shows the open-tag count).

| Action | How |
|---|---|
| **Tag an element** | `＋ Add` (or **Alt+A**) → hover highlights elements → **click** the element, or press **Enter** while hovering → type what should change → Save (**Ctrl/⌘+Enter**) |
| **Tag the whole page** | `▭ Page` → note → Save. Renders as a square badge top-left, not tied to an element |
| **Cancel arming** | **Esc** |
| **Inspect a tag** | Click its numbered pin → bubble shows the note, selector, screenshot |
| **Edit / delete** | In the bubble, or expand the tag's row in the panel |
| **Clear all** | `Clear` in the panel bar (confirms first) |

Tips:
- **Alt+A instead of the button** when tagging dropdowns/popovers — the hotkey doesn't click the page, so transient UI stays open; then hover + **Enter**.
- Tags are **route-bound**: pins show on the page where you made them. The panel's `This page` / `All` tabs split them.
- Elements with `data-testid` get the most robust selectors — the capture prefers them automatically.
- Write notes like change requests, not bug novels: "make this coral", "align with the card above", "this copy is too long". One tag per change.

### What a tag carries

Note + route + selector (+ nearby text hint), and after a beat: the **React component name** (read from the fiber tree) and a **cropped screenshot** of the element. Both appear automatically; on non-React or minified pages the component name just stays absent.

### Screenshots

Click a pin → the bubble shows the screenshot under your note. Hover it → **COPY PNG** → paste into any chat or editor (`copied ✓` confirms). An amber `uncropped` corner tag means the crop fell back to the full viewport. Files also land in `~/.overlay/screenshots/` once a bridge has synced.

---

## 4. The agent side

What `/overlay-on` does in your Claude Code session:

- Reads open tags from the bridge (`GET /api/tags`), including component names and notes
- **Views each element's screenshot** before editing
- Edits the real source in the current project — never the DOM
- `POST /api/resolve` per finished tag → the pin (and its list row) disappears in your browser
- Idles and re-polls about once a minute; batches if you tag a burst

The agent can also leave **blue pins** for you (`create_tag`) — questions or notes anchored to a page. You'll see them appear live.

Status at a glance — the panel bar shows a chip:

| Chip | Meaning |
|---|---|
| `⇅ bridge` (blue) | Connected — agent can see your tags |
| `⇅ off` (gray) | No bridge running — tagging still works, syncs later |
| `⇅ stale — refresh page` (amber) | You reloaded the extension; refresh this tab |

---

## 5. The manual flow (no agent)

The **Copy** button exports *all* open tags (every page), grouped by route, prefixed with a ready-made fix prompt. Paste into any AI chat. Selectors + text hints tell it where; your notes tell it what. Delete tags as the fixes land. This is also your fallback in Firefox-less-strict environments or when you want a different model to do the fixing.

---

## 6. Switching it off

Click the extension icon (toolbar) — the popup shows bridge status, tag count, and two live switches:

- **Show on this site** — hides the overlay on this origin only
- **Enabled everywhere** — master switch

Both unmount the overlay in place (pins, panel, hotkey — everything) with no page reload, and re-enable the same way. Tags are never deleted by switching off.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| No `💬` button on a page | Popup → both switches on? Page is `http(s)` (not `chrome://`, PDF, or the Web Store)? If your app already runs the Vite-plugin overlay, the extension deliberately stands down (single overlay per page). |
| Chip stuck on `⇅ off` | Start a session with `/overlay-on` (the bridge lives inside it). Still off after ~30 s → visit `http://localhost:8787/pair` once. |
| `⇅ stale — refresh page` | You reloaded the extension at `chrome://extensions`. Refresh the tab. Rule of thumb: **reload extension → refresh tabs**, always in that order. |
| Bubble has no screenshot | Only tags captured *after* install carry screenshots; give it a second after saving. The image lives in the pin bubble and the expanded panel row. |
| No component name on a tag | Page isn't React, is production-minified, or the element sits outside the app's tree — expected, degrades silently. |
| Agent session says port 8787 busy | Another session owns the bridge — that's fine, `/overlay-on` reuses it automatically. The loud exit only happens for a non-bridge process squatting the port: free it or pass `--port`. |
| Tags made offline didn't reach the agent | They sync in full the moment a bridge connects (`⇅ bridge`). Check the chip. |

---

## 8. Vite plugin (the original, still included)

Prefer an in-repo, extension-free setup for a single Vite app? `@idnerd/overlay` injects the same overlay into `vite dev` only (never builds), storing tags in `localStorage` with clipboard export — no screenshots/component names/sync. Setup and options: [root README → Vite plugin](../README.md#vite-plugin-1).
