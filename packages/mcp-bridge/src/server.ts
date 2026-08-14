import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { BridgeStore, Tag } from './store'

export interface ServerHandle {
  close(): Promise<void>
  broadcast(msg: object): void
  onConnectionChange?: (connected: boolean) => void
}

export function startServer(opts: { port: number; token: string; store: BridgeStore; onUp?: (msg: any) => void; testHttp?: boolean }): ServerHandle {
  const { port, token, store } = opts

  const clients = new Set<WebSocket>()
  const broadcast = (msg: object) => { for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg)) }

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => { let body = ''; req.on('data', c => body += c); req.on('end', () => resolve(body)) })

  const unauthorized = (res: http.ServerResponse) => {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' }))
  }
  const badRequest = (res: http.ServerResponse, error: string) => {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error }))
  }
  const tokenOf = (req: http.IncomingMessage): string | null => {
    const url = new URL(req.url ?? '/', 'http://x')
    return url.searchParams.get('token') ?? (req.headers['x-overlay-token'] as string | undefined) ?? null
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')

    if (url.pathname === '/api/tags' && req.method === 'GET') {
      if (tokenOf(req) !== token) return unauthorized(res)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(store.list()))
      return
    }
    if (url.pathname === '/api/resolve' && req.method === 'POST') {
      if (tokenOf(req) !== token) return unauthorized(res)
      readBody(req).then((body) => {
        let parsed: any
        try { parsed = JSON.parse(body) } catch { return badRequest(res, 'invalid JSON') }
        const { id } = parsed ?? {}
        if (!store.resolve(id)) {
          res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown id' }))
          return
        }
        broadcast({ type: 'resolve', id })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    if (url.pathname === '/api/create' && req.method === 'POST') {
      if (tokenOf(req) !== token) return unauthorized(res)
      readBody(req).then((body) => {
        let parsed: any
        try { parsed = JSON.parse(body) } catch { return badRequest(res, 'invalid JSON') }
        const { route, note, selector, scope } = parsed ?? {}
        if (!route || !note) return badRequest(res, 'route and note are required')
        const tag = store.create({ route, note, selector, scope })
        broadcast({ type: 'create', tag })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(tag))
      })
      return
    }

    if (opts.testHttp && req.url === '/__test/resolve' && req.method === 'POST') {
      readBody(req).then((body) => {
        const { id } = JSON.parse(body)
        if (!store.resolve(id)) {
          res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown id' }))
          return
        }
        broadcast({ type: 'resolve', id })
        res.writeHead(200); res.end('ok')
      })
      return
    }
    if (opts.testHttp && req.url === '/__test/create' && req.method === 'POST') {
      readBody(req).then((body) => {
        const tag = store.create(JSON.parse(body))
        broadcast({ type: 'create', tag })
        res.writeHead(200); res.end(JSON.stringify(tag))
      })
      return
    }
    if (req.url === '/pair' || req.url === '/pair/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><meta charset="utf-8">
<title>Overlay bridge pairing</title>
<body style="font:15px system-ui;max-width:480px;margin:80px auto">
  <h2>Overlay bridge</h2>
  <div id="ovl-pair" data-ovl-pair-token="${token}">
    Waiting for the extension to pick up the pairing token…<br>
    <small>If nothing happens in a few seconds, the extension is not installed or not enabled
    for localhost. Load it from <code>packages/extension/dist-ext</code> via chrome://extensions
    → "Load unpacked".</small>
  </div>
</body>`)
      return
    }
    res.writeHead(404); res.end()
  })

  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.searchParams.get('token') !== token) { ws.close(4001, 'bad token'); return }
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(String(raw)) } catch { return }
      try {
        if (msg.type === 'hello') { if (Array.isArray(msg.tags)) store.replaceAll(msg.tags as Tag[]) }
        else if (msg.type === 'upsert') {
          if (msg.tag?.id) {
            store.upsert(msg.tag as Tag)
            if (msg.shotBase64 && msg.tag.screenshotId) store.saveShot(msg.tag.screenshotId, msg.shotBase64)
          }
        }
        else if (msg.type === 'remove') store.remove(msg.id)
        else if (msg.type === 'clear') store.replaceAll([])
        opts.onUp?.(msg)
      } catch (e) {
        console.warn('overlay bridge: ignoring malformed WS message', e)
      }
    })
  })

  httpServer.listen(port)

  return {
    close: () => new Promise((res) => { for (const c of clients) c.close(); wss.close(); httpServer.close(() => res()) }),
    broadcast,
  }
}
