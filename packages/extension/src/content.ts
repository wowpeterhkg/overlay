import { createStore, asyncAdapter, mountOverlay, DEFAULT_PRESET } from '@idnerd/overlay-core'

const KEY = 'overlay_tags'

// Tracks JSON payloads this script itself has written but not yet seen
// echoed back via onChanged, so that listener can tell its own echoes apart
// from a genuine external write (service worker applying a bridge message).
// A list (not a Set) because if two writes happen to carry the same payload,
// each still needs its own echo consumed — multiset semantics. Lives in the
// module closure only.
const pendingWrites: string[] = []

// Set once we detect the extension has been reloaded/updated while this
// content script is still alive in the page (chrome.runtime.id throws/undefined
// on a dead context). Once true, we stop touching chrome.* APIs from this
// script entirely — every call would just throw "Extension context invalidated"
// and spam the console.
let ctxDead = false
function contextAlive(): boolean {
  try {
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

const store = createStore(asyncAdapter({
  get: async () => {
    if (!contextAlive()) { ctxDead = true; return '[]' }
    return (await chrome.storage.local.get(KEY))[KEY] ?? '[]'
  },
  set: async (v: string) => {
    if (ctxDead || !contextAlive()) { ctxDead = true; return }
    pendingWrites.push(v)
    await chrome.storage.local.set({ [KEY]: v })
  },
}))

let overlay: { render(): void; destroy(): void } | null = null

// Kill switches, both live-reactive via storage.onChanged: a global master
// (ovl_off_global) and a per-origin list (ovl_off_origins). The content
// script now runs on every http(s) page, so the popup needs a way to hide
// the overlay without uninstalling the extension.
const OFF_GLOBAL = 'ovl_off_global'
const OFF_ORIGINS = 'ovl_off_origins'

async function isDisabledHere(): Promise<boolean> {
  if (!contextAlive()) return true
  const v = await chrome.storage.local.get([OFF_GLOBAL, OFF_ORIGINS])
  if (v[OFF_GLOBAL]) return true
  const origins: string[] = v[OFF_ORIGINS] ?? []
  return origins.includes(location.origin)
}

function unmountUi() {
  overlay?.destroy()
  overlay = null
}

// MAIN-world fiber-probe RPC — see packages/extension/src/probe.js. content.ts
// (isolated world) has no access to React's __reactFiber$* expandos, so it
// hands the target element to probe.js via a temporary DOM attribute (the
// only thing shared across worlds) and awaits a postMessage reply.
let probeSeq = 0
function detectComponent(target: Element | null): Promise<string | undefined> {
  if (!target) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const seq = String(++probeSeq)
    target.setAttribute('data-ovl-probe', seq)
    const timer = setTimeout(() => { cleanup(); resolve(undefined) }, 300)
    function onMsg(e: MessageEvent) {
      if (e.source !== window || !e.data?.__ovlProbeResult || e.data.__ovlProbeResult.seq !== seq) return
      cleanup()
      resolve(e.data.__ovlProbeResult.component ?? undefined)
    }
    function cleanup() {
      clearTimeout(timer)
      window.removeEventListener('message', onMsg)
      target!.removeAttribute('data-ovl-probe')
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ __ovlProbe: { seq } }, '*')
  })
}

function mountUi() {
  if (document.getElementById('overlay-root')) return // vite-plugin already mounted — don't double-mount
  overlay = mountOverlay({
    store, preset: DEFAULT_PRESET, hotkey: 'Alt+A',
    enrich: async (_tag: unknown, target: Element | null) => {
      if (ctxDead || !contextAlive()) { ctxDead = true; return null }
      const patch: Record<string, unknown> = {}
      const component = await detectComponent(target)
      if (component) patch.component = component
      if (target) {
        const r = target.getBoundingClientRect()
        const resp = await chrome.runtime.sendMessage({
          kind: 'ovl-shot',
          rect: { x: r.left, y: r.top, w: r.width, h: r.height },
          dpr: window.devicePixelRatio,
        }).catch(() => null)
        if (resp?.screenshotId) patch.screenshotId = resp.screenshotId
      }
      return Object.keys(patch).length ? patch : null
    },
    getShot: async (tag: { screenshotId?: string }) => {
      if (ctxDead || !contextAlive()) { ctxDead = true; return null }
      if (!tag.screenshotId) return null
      const r = await chrome.runtime.sendMessage({ kind: 'ovl-get-shot', id: tag.screenshotId }).catch(() => null)
      return r?.dataUrl ? { dataUrl: r.dataUrl, cropped: r.cropped !== false } : null
    },
  } as Parameters<typeof mountOverlay>[0])
}

store.ready.then(async () => {
  if (!(await isDisabledHere())) mountUi()

  // Popup toggles → mount/unmount in place, no page reload needed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes[OFF_GLOBAL] || changes[OFF_ORIGINS])) return
    isDisabledHere().then((off) => {
      if (off) unmountUi()
      else if (!overlay) mountUi()
    })
  })

  // External writes (service worker applying bridge messages) → reload + re-render.
  // Self-writes also fire this listener; if the new value matches one of our
  // own in-flight writes, it's our own echo — consume it (so a repeated
  // payload's next echo isn't mistaken for this one) and skip the reload,
  // since reloading anyway risks clobbering a mutation made between our
  // write and the echo arriving.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return
    const nv = changes[KEY].newValue
    const i = typeof nv === 'string' ? pendingWrites.indexOf(nv) : -1
    if (i !== -1) {
      pendingWrites.splice(i, 1)
      return
    }
    store.reload().then(() => overlay && overlay.render())
  })
})

// Pairing: the bridge's /pair page renders the token in a marker element.
// We only ever read it on localhost:<port>/pair (this script only runs on localhost anyway).
if (location.pathname.startsWith('/pair')) {
  const marker = document.querySelector('[data-ovl-pair-token]')
  if (marker) {
    const token = marker.getAttribute('data-ovl-pair-token')!
    const port = Number(location.port || '8787')
    chrome.storage.local.set({ ovl_token: token, ovl_port: port }).then(() => {
      chrome.runtime.sendMessage({ kind: 'ovl-paired' })
      marker.innerHTML = '<b>✓ Paired.</b> You can close this tab — the extension is now connected to the bridge.'
    })
  }
}

// Bridge status chip — polls the SW every 5s, injects into the panel bar.
setInterval(async () => {
  if (!overlay) return   // double-mount guard skipped mounting — this is the vite-plugin's own overlay, not ours
  const bar = document.querySelector('#overlay-root .ovl-bar')
  if (!bar) return
  let chip = bar.querySelector('.ovl-bridge-chip') as HTMLElement | null
  if (ctxDead || !contextAlive()) {
    ctxDead = true
    if (chip) {
      chip.textContent = '⇅ stale — refresh page'
      chip.style.color = '#C58A2E'
    }
    return
  }
  if (!chip) {
    chip = document.createElement('span')
    chip.className = 'ovl-chip ovl-bridge-chip'
    bar.appendChild(chip)
  }
  const s = await chrome.runtime.sendMessage({ kind: 'ovl-status' }).catch(() => null)
  chip.textContent = s?.connected ? '⇅ bridge' : '⇅ off'
  chip.style.color = s?.connected ? '#3B6FB5' : '#8E8880'
}, 5_000)
