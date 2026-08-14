# @idnerd/overlay-extension

MV3 Chrome extension that mounts the overlay (from `@idnerd/overlay-core`) on any site, adds element screenshots and React component-name detection, and syncs to the `@idnerd/overlay-mcp` bridge over WebSocket. Fully functional with no bridge running — see the [degradation principle](../../README.md#degradation-principle) in the root README.

## Build

```bash
npm install
npm run build     # tsup (content/probe/sw/popup bundles) + scripts/package.mjs → dist-ext/
```

`dist-ext/` is the loadable extension directory (manifest, bundled JS, `popup.html`, icon). `dist/` is the raw tsup output; load `dist-ext/`, not `dist/`.

## Load unpacked

1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `packages/extension/dist-ext`

The extension auto-activates on every `http://` and `https://` page — local dev servers, TLS or not, and remote staging or cloud environments alike. No per-site step, no reload.

The bridge itself stays plain `http`/`ws` on `127.0.0.1`, regardless of the page's scheme. Browsers treat loopback as a potentially-trustworthy origin, so it is exempt from mixed-content blocking; and in any case the page never contacts the bridge directly — `content.ts` only talks to the service worker over `chrome.runtime`, and the service worker owns the WebSocket. No local certificate is needed at any point.

## Turning it off

Because the content script runs everywhere, the popup is an opt-**out** rather than an opt-in. Two checkboxes, both applied live — the overlay mounts or unmounts in place, no page reload:

- **Show on this site** — per-origin. Unchecking adds `location.origin` to `ovl_off_origins` in `chrome.storage.local`.
- **Enabled everywhere** — master switch, stored as `ovl_off_global`. When off, the per-site box is disabled and the overlay is hidden on every page.

`content.ts` reads both keys on mount and subscribes to `chrome.storage.onChanged`, so toggling from the popup takes effect immediately in already-open tabs.

## Status chip

The overlay panel (bottom-right FAB → panel bar) shows a small chip: **⇅ bridge** (blue) when the WebSocket to the bridge is connected, **⇅ off** (grey) otherwise. It polls the service worker every 5 seconds. The popup shows the same connection state plus a live tag count.

## Permissions

`manifest.json` requests:

- `storage`, `unlimitedStorage` — tag + screenshot persistence in `chrome.storage.local` / IndexedDB.
- `activeTab`, `scripting` — retained from the former on-demand injection flow; no longer exercised now that `content_scripts` cover all http(s) origins declaratively.
- `host_permissions`: `http://localhost/*`, `http://127.0.0.1/*` **and `<all_urls>`**. `content_scripts[].matches` is `http://*/*` + `https://*/*`, so the scripts run on every page unconditionally; the loopback entries are redundant with `<all_urls>` and kept only as documentation of intent.
- `optional_host_permissions` is **not currently declared**. It was removed because Chrome logs a redundancy warning at load when `optional_host_permissions` requests origins already covered by `<all_urls>` in `host_permissions` — see below for when it needs to come back.

**Why `<all_urls>` is in `host_permissions` instead of an `optional_host_permissions` request flow:** element screenshots go through `chrome.tabs.captureVisibleTab`, which Chrome only allows without an `activeTab` user-gesture context in the specific capture call the sw makes (triggered by a message from the content script, not a direct user click on the extension icon). Without a broad host permission already granted, that call is denied. `activeTab` alone does not cover it because the gesture chain is broken by the async round trip through the content script. This means installing the extension grants screenshot-capture reach everywhere, not just on sites the user explicitly enabled — a deviation from the spec's original localhost-only-install posture (spec §3, "per-site opt-in").

The former per-site `chrome.permissions.request({ origins: [...] })` flow has been removed from `popup.ts` — the popup now toggles storage-backed kill switches instead of requesting grants, because `content_scripts` already match all http(s) origins. **This makes the distribution question sharper, not softer:** the extension now reads and mounts on every page a user visits by default, with opt-out rather than opt-in. **Revisit this before distributing beyond local/dev use** — that posture needs either a narrower `matches` list plus a real `optional_host_permissions` request flow (`["http://*/*", "https://*/*"]`) restored, or an explicit, disclosed justification. If `<all_urls>` is ever dropped from `host_permissions`, screenshot capture must also be re-scoped to fire only after a grant, degrading gracefully to no-screenshot otherwise.

**The kill switches gate mounting, not injection.** `content.js` and `probe.js` (MAIN world) are still declaratively injected by `content_scripts[].matches` on every http(s) page load, even when `ovl_off_global` or `ovl_off_origins` says the overlay should be hidden there — `isDisabledHere()` is checked *after* injection, to decide whether to call `mountUi()`. `probe.js` is passive: it only replies to `postMessage` probes sent by `content.ts`'s own fiber-detection RPC, and does nothing unsolicited.

## Architecture notes

- `content.ts` (isolated world) mounts the overlay via `@idnerd/overlay-core`'s `createStore`/`mountOverlay`, using `chrome.storage.local` as the async adapter backing store.
- `probe.js` (MAIN world) does React fiber walking for component-name detection; `content.ts` talks to it via a `postMessage` RPC (isolated world has no access to React's `__reactFiber$*` expandos).
- `sw.ts` (service worker) owns the WebSocket connection to the bridge, `chrome.tabs.captureVisibleTab` + crop (`crop.ts`), and the IndexedDB screenshot store (`idb.ts`).
- Pairing: visiting the bridge's `/pair` page (only reachable on localhost, where the content script already runs) reads a token off a marker element and stores it via `chrome.storage.local`, then notifies the service worker to (re)connect.
