import { cropDataUrl, type Rect } from './crop'
import { putShot, getShot } from './idb'

function uid() { return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36) }

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  let bin = ''
  new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b) })
  return `data:${blob.type};base64,${btoa(bin)}`
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === 'ovl-shot') {
    ;(async () => {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab!.windowId, { format: 'png' })
        const { blob, cropped } = await cropDataUrl(dataUrl, msg.rect as Rect, msg.dpr)
        const id = uid()
        await putShot(id, { blob, cropped, createdAt: Date.now() })
        sendResponse({ screenshotId: id, cropped })
      } catch (e) {
        sendResponse({ error: String(e) })   // spec §8: tag saves without an image
      }
    })()
    return true // async sendResponse
  }
  if (msg?.kind === 'ovl-status') {
    ;(async () => {
      const v = await chrome.storage.local.get('overlay_tags')
      const tags = JSON.parse((v['overlay_tags'] as string) ?? '[]')
      sendResponse({ connected: wsConnected(), tagCount: tags.length })
    })()
    return true
  }
  if (msg?.kind === 'ovl-get-shot') {
    ;(async () => {
      const rec = await getShot(msg.id)
      sendResponse(rec ? { dataUrl: await blobToDataUrl(rec.blob), cropped: rec.cropped } : { error: 'not found' })
    })()
    return true
  }
})

const KEY = 'overlay_tags'
let ws: WebSocket | null = null
let backoff = 1000
let lastTags: Map<string, string> = new Map()  // id -> JSON, for diffing
let keepalive: ReturnType<typeof setInterval> | null = null

export function wsConnected() { return !!ws && ws.readyState === WebSocket.OPEN }

async function readTags(): Promise<any[]> {
  const v = await chrome.storage.local.get(KEY)
  return JSON.parse((v[KEY] as string) ?? '[]')
}
async function writeTags(tags: any[]) {
  await chrome.storage.local.set({ [KEY]: JSON.stringify(tags) })
}

async function connect() {
  const cfg = await chrome.storage.local.get(['ovl_token', 'ovl_port'])
  if (!cfg.ovl_token) return   // not paired yet — fully-functional standalone (spec §3.2)
  const port = cfg.ovl_port ?? 8787
  // Pinned to 127.0.0.1 (not "localhost") so the socket target resolves
  // deterministically on dual-stack hosts, independent of how the pair page
  // itself was addressed.
  let sock: WebSocket
  try { sock = new WebSocket(`ws://127.0.0.1:${port}/?token=${cfg.ovl_token}`) } catch { scheduleReconnect(); return }
  ws = sock

  // Own keepalive handle for THIS socket, captured in this closure. `ws`/
  // `keepalive`/`backoff` are shared module vars; re-pair (`ovl-paired`)
  // calls `ws?.close(); connect()` which races the old socket's async
  // `onclose` against the new socket being assigned to `ws`. Every handler
  // below re-checks `ws === sock` before touching shared state so a stale
  // socket's late-firing events can never null out or reconnect over a
  // live connection.
  let localKeepalive: ReturnType<typeof setInterval> | null = null

  sock.onopen = async () => {
    if (ws !== sock) return
    backoff = 1000
    const tags = await readTags()
    lastTags = new Map(tags.map(t => [t.id, JSON.stringify(t)]))
    sock.send(JSON.stringify({ type: 'hello', tags }))          // full re-push: extension state wins (spec §7)
    if (keepalive) clearInterval(keepalive)                     // clear any prior socket's keepalive before starting ours
    localKeepalive = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: 'pong' })), 20_000)
    keepalive = localKeepalive
  }
  sock.onmessage = async (e) => {
    if (ws !== sock) return
    const msg = JSON.parse(e.data as string)
    if (msg.type === 'ping') { sock.send(JSON.stringify({ type: 'pong' })); return }
    const tags = await readTags()
    if (msg.type === 'resolve') {
      const t = tags.find((t: any) => t.id === msg.id)
      if (t) {
        t.status = 'resolved'
        // Update lastTags BEFORE the storage write so the onChanged diff
        // below — which can fire synchronously off this same write — never
        // observes a delta for this id. Setting it after the await left a
        // window where the diff would see the old lastTags entry and echo
        // this Down straight back up as a spurious 'upsert'.
        lastTags.set(t.id, JSON.stringify(t))
        await writeTags(tags)                                  // storage write → content re-renders
      }
    } else if (msg.type === 'create') {
      tags.push(msg.tag)
      lastTags.set(msg.tag.id, JSON.stringify(msg.tag))         // same lockstep-before-write as resolve, above
      await writeTags(tags)
    }
  }
  sock.onclose = () => {
    if (localKeepalive) clearInterval(localKeepalive)           // always clear this socket's own timer
    if (ws !== sock) return                                     // stale socket — live connection already replaced it
    ws = null
    keepalive = null
    scheduleReconnect()
  }
  sock.onerror = () => { if (ws !== sock) return; sock.close() }
}
function scheduleReconnect() {
  setTimeout(connect, backoff)
  backoff = Math.min(backoff * 2, 30_000)
}

// Mirror local changes up as deltas (diff old vs new to find what changed).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[KEY] || !wsConnected()) return
  const sock = ws                                              // pin this socket for the whole delta loop
  const next: any[] = JSON.parse((changes[KEY].newValue as string) ?? '[]')
  const nextMap = new Map(next.map(t => [t.id, JSON.stringify(t)]))
  for (const [id, json] of nextMap) {
    const prevJson = lastTags.get(id)
    if (prevJson !== json) {
      const tag = JSON.parse(json)
      let shotBase64: string | undefined
      // Capture always does two writes: store.add (no screenshotId yet, but
      // `id` becomes known in lastTags) then the enrich store.update
      // (screenshotId appears on an id that's already in lastTags). Gating
      // on `!lastTags.has(id)` would miss that second write entirely, so the
      // bytes would never be sent. Gate on "screenshotId newly appeared"
      // instead — compare against the previous entry's own screenshotId.
      //
      // KNOWN GAP (deferred, not fixed here): this still only catches the
      // transition the moment it happens locally. If the bridge process
      // restarts and loses its screenshots/ dir, existing shots cannot be
      // re-pushed this way, because `hello` carries tag metadata only, no
      // image bytes. Fixing this properly needs a protocol change (e.g.
      // bridge negotiating which screenshotIds it's missing on hello-ack) —
      // out of scope for this pass.
      const prevShot = prevJson ? JSON.parse(prevJson).screenshotId : undefined
      if (tag.screenshotId && tag.screenshotId !== prevShot) {   // push image when screenshotId newly appears
        const rec = await getShot(tag.screenshotId)
        if (rec) shotBase64 = (await blobToDataUrl(rec.blob)).split(',')[1]
      }
      if (ws !== sock) return                                  // reconnected mid-loop — stale socket, abandon this delta pass
      sock!.send(JSON.stringify({ type: 'upsert', tag, shotBase64 }))
    }
  }
  if (ws !== sock) return
  for (const id of lastTags.keys()) if (!nextMap.has(id)) sock!.send(JSON.stringify({ type: 'remove', id }))
  if (next.length === 0 && lastTags.size > 0) sock!.send(JSON.stringify({ type: 'clear' }))
  lastTags = nextMap
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === 'ovl-paired') { ws?.close(); backoff = 1000; connect() }
})

connect()
