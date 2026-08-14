# @idnerd/overlay-mcp

Node CLI (`overlay-mcp`) that runs one process wearing two hats: an MCP stdio server for Claude Code / Cursor, and a WebSocket server the `@idnerd/overlay-extension` browser extension connects to. It mirrors extension state — it is never the source of truth for tags; see [Sync model](../../docs/superpowers/specs/2026-07-28-extension-mcp-design.md#7-sync-model) in the design spec.

## Build

```bash
npm install
npm run build   # tsup → dist/cli.js
```

## Run

```bash
node dist/cli.js
# or, once published:
npx @idnerd/overlay-mcp
```

Register with Claude Code:

```bash
claude mcp add overlay -- node <abs-path>/packages/mcp-bridge/dist/cli.js
```

## Flags

| Flag | Default | What it does |
|---|---|---|
| `--port <n>` | `8787` | HTTP + WebSocket port. On collision (`EADDRINUSE`) the process exits with a message naming the conflicting port and this flag, rather than silently picking another. |
| `--dir <path>` | `~/.overlay` | Storage root — see **Storage layout** below. |
| `--test-http` | off | **Test-only.** Enables `POST /__test/resolve` and `POST /__test/create`, which call the exact same internal store-mutation + broadcast paths as the `resolve_tag`/`create_tag` MCP tools. Exists because an e2e test can't cleanly act as the MCP client while the bridge also serves the live extension over WebSocket. Never enable this outside test harnesses — it's an unauthenticated local HTTP mutation surface. Also suppresses the first-run browser auto-open of `/pair`. |

## Storage layout

Under `--dir` (default `~/.overlay/`):

| Path | Contents |
|---|---|
| `token` | The pairing token, generated on first run and reused across restarts. |
| `tags.json` | The full mirrored tag store, written atomically (write to `.tmp`, then rename). |
| `screenshots/<id>.png` | Cropped element screenshots, keyed by `screenshotId`. |

## Pairing

On first run (no `token` file yet), the bridge generates one, writes it to `--dir`/`token`, and opens `http://localhost:<port>/pair` in the default browser (`--test-http` suppresses this). That page renders the token in a `data-ovl-pair-token` marker element. The extension's content script runs on every http(s) page (including localhost), so it runs on that page too, reads the marker, and stores the token — no copy-paste, and no `externally_connectable`/`chrome.runtime.sendMessage` bridge from the page itself. The extension persists the token in `chrome.storage.local` and presents it on every subsequent WebSocket connection (`ws://127.0.0.1:<port>/?token=...`); connections with a missing or wrong token are closed with code `4001`.

If the extension is not installed, the `/pair` page says so rather than hanging silently.

## Protocol

Two message directions over the WebSocket connection (types in `src/protocol.ts`, duplicated verbatim in `packages/extension/src/protocol.ts` since the two packages don't share a build graph):

| Direction | Type | Payload | Meaning |
|---|---|---|---|
| Up (extension → bridge) | `hello` | `{ tags: Tag[] }` | Full re-push on every (re)connect; bridge replaces its store wholesale. Extension state always wins after a reconnect. |
| Up | `upsert` | `{ tag: Tag, shotBase64? }` | One tag created/changed locally; optionally carries a screenshot's base64 bytes, pushed once on first sight. |
| Up | `remove` | `{ id: string }` | Tag deleted locally. |
| Up | `clear` | `{}` | All tags cleared locally. |
| Up | `pong` | `{}` | Keepalive response, sent every 20s regardless of `ping`. |
| Down (bridge → extension) | `resolve` | `{ id: string }` | `resolve_tag` MCP tool call; extension marks the tag resolved in `chrome.storage.local`. |
| Down | `create` | `{ tag: Tag }` | `create_tag` MCP tool call; extension appends the tag. |
| Down | `ping` | `{}` | Liveness probe. |

## MCP tools

See the [root README](../../README.md#mcp-tools) for the tool table (`list_tags`, `get_screenshot`, `resolve_tag`, `create_tag`).

## HTTP API

Always on (unlike `/__test/*` above), token-gated, mirroring the same store-mutation + broadcast paths as the MCP tools. This is how the `/overlay-on` skill drives the bridge from a shell — MCP stdio remains the integration point for Claude Desktop/Cursor, which don't have a shell-friendly way to reach a running bridge process.

**Auth:** pass the token either as a `?token=<t>` query param or an `X-Overlay-Token` header. A missing or mismatched token gets `401 {"error":"unauthorized"}`.

| Method & path | Body | Response |
|---|---|---|
| `GET /api/tags` | — | `200` full tag array (`store.list()`) |
| `POST /api/resolve` | `{ id }` | Unknown id → `404 {"error":"unknown id"}`, no broadcast. Known id → `store.resolve(id)`, broadcasts `{type:'resolve', id}`, `200 {"ok":true}` |
| `POST /api/create` | `{ route, note, selector?, scope? }` | Missing `route`/`note` → `400`. Otherwise `store.create(...)`, broadcasts `{type:'create', tag}`, `200` with the created tag |

```bash
curl "http://localhost:8787/api/tags?token=$TOKEN"

curl -X POST "http://localhost:8787/api/resolve?token=$TOKEN" \
  -d '{"id":"c1abc"}'

curl -X POST "http://localhost:8787/api/create" \
  -H "X-Overlay-Token: $TOKEN" \
  -d '{"route":"/","note":"tighten this spacing"}'
```

## Known limitations

- **Screenshot re-push gap.** The extension pushes a screenshot's `shotBase64` only at the moment its `screenshotId` newly appears on a tag locally (capture, then an enrich patch a beat later). If the bridge process restarts and its `--dir`/`screenshots/` directory is lost (e.g. a different `--dir`, or the directory was cleared), tags that already had screenshots on the extension side will not have their image bytes re-sent — the `hello` message on reconnect carries tag metadata only, not image bytes, and that "newly appeared" moment has already passed. Fixing this needs a protocol change (e.g. the bridge negotiating which `screenshotId`s it's missing as part of the `hello` handshake); out of scope for this pass. In practice this only bites if you wipe or relocate the storage directory while the extension still holds tags with screenshots — a normal bridge restart with the same `--dir` is unaffected, since `tags.json` and `screenshots/` persist on disk.
