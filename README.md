# @idnerd/overlay

Point at the UI, say what's wrong, watch it get fixed.

Overlay is a dev-tool loop for React apps: tag any element on your **running** app ("make this button green"), and a coding agent reads the tag — note, selector, React component name, and an auto-cropped screenshot of the element — fixes the real source, and resolves the tag so its pin disappears in your browser, live. No copy-pasting DOM snippets into chat.

```
you tag in the browser ──► bridge mirrors to disk ──► agent fixes source ──► pin vanishes
```

- **New here?** Start with the **[User Guide](docs/GUIDE.md)** — install to first fixed tag in ~5 minutes.
- **How it works inside:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the extension/bridge/agent data flow.
- Works on any `http(s)` page — local dev servers, staging, cloud previews. The browser extension runs everywhere by default with per-site and global off switches in the popup.
- Degrades gracefully: with no bridge or agent running, it's still a standalone tagging tool with clipboard export.

## Monorepo layout

| Package | What it is |
|---|---|
| `packages/core` (`@idnerd/overlay-core`) | Framework-agnostic store + overlay UI. `createStore(adapter)`, `mountOverlay(...)`, adapters for localStorage / async storage. Shared by the Vite plugin and the extension. |
| `packages/vite-plugin` (`@idnerd/overlay`) | The original v1: injects the overlay into a Vite dev server, `apply: 'serve'` so it's absent from production builds. |
| `packages/extension` (`@idnerd/overlay-extension`) | MV3 Chrome extension — mounts the same overlay on any site, adds element screenshots and React component-name detection, syncs to the bridge over WebSocket. |
| `packages/mcp-bridge` (`@idnerd/overlay-mcp`) | Node CLI (`overlay-mcp`) — one process, two hats: an MCP stdio server for Claude Code/Cursor, and a WebSocket server the extension connects to. Mirrors extension state; never a source of truth. |

## Install

Full hands-on walkthrough: **[User Guide](docs/GUIDE.md)**. Short version:

### Extension (the main event)

Not on the Chrome Web Store yet. Load unpacked:

1. `npm install && npm run build` (repo root) — produces `packages/extension/dist-ext`.
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `packages/extension/dist-ext`.

The extension activates on every `http://` and `https://` page — local dev servers, staging, cloud environments — no per-site step. To hide it somewhere, open the popup: **Show on this site** (per-origin) and **Enabled everywhere** (master switch), both applied live without a reload. See [packages/extension/README.md](packages/extension/README.md) for the permission details behind this posture.

### Bridge + agent

- **Claude Code:** don't register or start anything — copy [`commands/`](commands) into `~/.claude/commands/` and run `/overlay-on` in the project you want fixed. It spawns (or reuses) the bridge and starts working tags.
- **Claude Desktop / Cursor:** register the bridge as an MCP server:

  ```bash
  claude mcp add overlay -- node <abs-path>/packages/mcp-bridge/dist/cli.js
  ```

- Manual/standalone bridge run: `node packages/mcp-bridge/dist/cli.js` (or `npx @idnerd/overlay-mcp` once published).

On the bridge's first run it opens `http://localhost:8787/pair`; with the extension installed the page pairs itself (token passed automatically, no copy-paste). See [packages/mcp-bridge/README.md](packages/mcp-bridge/README.md).

### Vite plugin (legacy / extension-free option)

Local package for now (not published):

```json
// your app's package.json
"dependencies": {
  "@idnerd/overlay": "file:../overlay"
}
```

Build once in this repo: `npm install && npm run build`. See [Vite plugin](#vite-plugin-1) below for setup, options, and the tagging workflow — unchanged from v1.

## Driving it from an agent

Two ways, same store underneath:

- **Claude Code — `/overlay-on`:** the one-command flow. It spawns (or reuses) the bridge and loops — read open tags, view each screenshot, fix the source in the current project, resolve (pin vanishes in the browser), watch for more. No MCP registration needed; nothing loads unless you invoke it. `/overlay-off` stops it. Command files live in [`commands/`](commands) — copy them into `~/.claude/commands/`. Under the hood this uses the bridge's token-gated HTTP API (`GET /api/tags`, `POST /api/resolve`, `POST /api/create`).
- **Claude Desktop / Cursor — MCP:** register the bridge (`claude mcp add …` above); the four tools below appear in-session.

## MCP tools

| Tool | Input | Returns / effect |
|---|---|---|
| `list_tags` | `{ route?, includeResolved? }` | Open tags: id, route, scope, selector, testid, textHint, component, note, origin, whether a screenshot exists |
| `get_screenshot` | `{ id }` | The cropped PNG as MCP image content (not a path) so the model can actually see it |
| `resolve_tag` | `{ id }` | Marks the tag resolved; propagates down; the pin disappears live in the browser |
| `create_tag` | `{ route, selector?, note, scope? }` | Creates a tag with `origin: 'agent'`, rendered in a distinct color |

## Degradation principle

The extension is fully functional with no bridge running — tags, screenshots, and clipboard export all work standalone. The bridge and MCP tools are a strict enhancement layer: a bridge that's not started, or that crashes mid-session, never blocks capture.

---

## Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import overlay from '@idnerd/overlay/vite'

export default defineConfig({
  plugins: [react(), overlay()],
})
```

Run `vite dev` — a 💬 FAB appears bottom-right. That's it.

### Options

| Option | Default | What it does |
|---|---|---|
| `preset` | built-in generic prompt | Fix-prompt text prepended to the clipboard export |
| `storageKey` | `'overlay_tags'` | localStorage key for tags |
| `hotkey` | `'Alt+A'` | Arm-to-tag shortcut (`'<Alt\|Ctrl\|Shift\|Meta>+<key>'`) |

```ts
overlay({ storageKey: 'myapp_tags', hotkey: 'Alt+Q' })
```

## The loop

1. **Tag:** `＋ Add` (or the hotkey) → hover highlights elements → click or press **Enter** to capture → type the change you want → Save. `▭ Page` tags the whole page/layout.
2. Pins persist in localStorage, bound to their route; the panel lists this page / all pages.
3. **Copy:** one click exports every tag, grouped by route, with `sel=` selectors (data-testid preferred) plus the fix prompt.
4. Paste into your AI agent; it edits the real source. Delete tags (or **Clear** all) as feedback lands.

### Keyboard

- **Alt+A** — arm/disarm tagging without clicking the panel (open dropdowns stay open)
- **Enter** — capture the hovered element while armed (no click, keeps transient UI open)
- **Esc** — cancel arming / close the composer
- **Ctrl/⌘+Enter** — save in the composer

## Production safety

The plugin is `apply: 'serve'` — it does not exist during `vite build` — and the injected script re-guards on `import.meta.env.DEV`. Verify yourself: `npm run build` in your app and grep `dist/` for `overlay-root`; zero hits.

## Roadmap

- **Round 2 — agent integration:** shipped. See the extension and bridge packages above.
- **Round 2 — source locations:** optional `source: {file, line}` per tag via React fiber detection (schema slot reserved; the extension currently records `component` name, not file/line).

## Development notes

- Root `package.json` pins `overrides: { "zod": "3.25.76" }`. `@idnerd/overlay-mcp` and its transitive `@modelcontextprotocol/sdk` dependency both pull in `zod`; without the override, npm workspaces can dual-hoist two `zod` versions, which TypeScript then fails to reconcile in structural checks (`error TS2589: Type instantiation is excessively deep`). Pinning a single version across the workspace avoids it. Don't remove without re-checking that combination.

## Acknowledgements

The overlay concept, UI, tag schema, extension, bridge, and MCP integration are original work. Two structural choices in the Vite plugin were inspired by [instruckt](https://github.com/joshcirre/instruckt) (MIT) — the serve-only injection pattern (`apply: 'serve'` + `transformIndexHtml`, so the overlay exists in dev and never in builds) and the dual-entry package layout (`.` client / `./vite` plugin). No code was copied and there is no dependency; thanks to joshcirre for a clean reference on those patterns.
