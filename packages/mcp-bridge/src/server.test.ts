import { describe, it, expect, afterEach } from 'vitest'
import { startServer } from './server'
import { BridgeStore } from './store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

let stop: (() => Promise<void>) | null = null
afterEach(async () => { if (stop) await stop(); stop = null })

function boot(port: number, opts: { testHttp?: boolean } = {}) {
  const store = new BridgeStore(mkdtempSync(path.join(tmpdir(), 'ovl-')))
  const srv = startServer({ port, token: 'tok123', store, testHttp: opts.testHttp })
  stop = srv.close
  return { srv, store }
}

describe('bridge server', () => {
  it('GET /pair serves HTML containing the token marker', async () => {
    boot(8791)
    const html = await (await fetch('http://localhost:8791/pair')).text()
    expect(html).toContain('data-ovl-pair-token="tok123"')
  })
  it('WS without valid token is rejected', async () => {
    boot(8792)
    const ws = new WebSocket('ws://localhost:8792/?token=wrong')
    await new Promise<void>(res => { ws.on('close', () => res()); ws.on('error', () => {}) })
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
  it('hello replaces the store; upsert/remove mutate it', async () => {
    const { store } = boot(8793)
    const ws = new WebSocket('ws://localhost:8793/?token=tok123')
    await new Promise(res => ws.on('open', res))
    const tag = { id: 'c1', route: '/', scope: 'element', selector: 'x', testid: null, textHint: '', note: 'n', createdAt: 1 }
    ws.send(JSON.stringify({ type: 'hello', tags: [tag] }))
    await new Promise(r => setTimeout(r, 100))
    expect(store.list().length).toBe(1)
    ws.send(JSON.stringify({ type: 'remove', id: 'c1' }))
    await new Promise(r => setTimeout(r, 100))
    expect(store.list().length).toBe(0)
    ws.close()
  })
  it('survives a malformed hello message (no tags) and keeps serving later messages', async () => {
    const { store } = boot(8798)
    const ws = new WebSocket('ws://localhost:8798/?token=tok123')
    await new Promise(res => ws.on('open', res))
    ws.send(JSON.stringify({ type: 'hello' }))                  // missing `tags` — must not crash the server
    await new Promise(r => setTimeout(r, 100))
    const tag = { id: 'c1', route: '/', scope: 'element', selector: 'x', testid: null, textHint: '', note: 'n', createdAt: 1 }
    ws.send(JSON.stringify({ type: 'upsert', tag }))            // a valid message afterward should still work
    await new Promise(r => setTimeout(r, 100))
    expect(store.list().map(t => t.id)).toEqual(['c1'])
    ws.close()
  })
  it('__test endpoints 404 when testHttp is not enabled', async () => {
    boot(8795)
    const r1 = await fetch('http://localhost:8795/__test/resolve', { method: 'POST', body: JSON.stringify({ id: 'x' }) })
    expect(r1.status).toBe(404)
    const r2 = await fetch('http://localhost:8795/__test/create', { method: 'POST', body: JSON.stringify({ route: '/', note: 'n' }) })
    expect(r2.status).toBe(404)
  })
  it('__test/resolve with unknown id 404s without broadcasting', async () => {
    boot(8796, { testHttp: true })
    const ws = new WebSocket('ws://localhost:8796/?token=tok123')
    await new Promise(res => ws.on('open', res))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(String(raw))))

    const res = await fetch('http://localhost:8796/__test/resolve', { method: 'POST', body: JSON.stringify({ id: 'missing' }) })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown id' })

    await new Promise(r => setTimeout(r, 300))
    expect(received.filter(m => m.type === 'resolve')).toEqual([])
    ws.close()
  })
  it('__test/resolve with known id 200s and broadcasts to WS clients', async () => {
    const { store } = boot(8797, { testHttp: true })
    store.upsert({ id: 'c1', route: '/', scope: 'element', selector: 'x', testid: null, textHint: '', note: 'n', createdAt: 1 })
    const ws = new WebSocket('ws://localhost:8797/?token=tok123')
    await new Promise(res => ws.on('open', res))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(String(raw))))

    const res = await fetch('http://localhost:8797/__test/resolve', { method: 'POST', body: JSON.stringify({ id: 'c1' }) })
    expect(res.status).toBe(200)

    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (received.some(m => m.type === 'resolve' && m.id === 'c1')) return resolve()
        if (Date.now() - start > 2000) return reject(new Error('timed out waiting for resolve broadcast'))
        setTimeout(check, 20)
      }
      check()
    })
    ws.close()
  })
  it('GET /api/tags 401s without a token and with the wrong token', async () => {
    boot(8801)
    const r1 = await fetch('http://localhost:8801/api/tags')
    expect(r1.status).toBe(401)
    expect(await r1.json()).toEqual({ error: 'unauthorized' })
    const r2 = await fetch('http://localhost:8801/api/tags?token=wrong')
    expect(r2.status).toBe(401)
  })
  it('POST /api/resolve 401s without a token and with the wrong token', async () => {
    boot(8802)
    const r1 = await fetch('http://localhost:8802/api/resolve', { method: 'POST', body: JSON.stringify({ id: 'x' }) })
    expect(r1.status).toBe(401)
    const r2 = await fetch('http://localhost:8802/api/resolve?token=wrong', { method: 'POST', body: JSON.stringify({ id: 'x' }) })
    expect(r2.status).toBe(401)
  })
  it('POST /api/create 401s without a token and with the wrong token', async () => {
    boot(8803)
    const r1 = await fetch('http://localhost:8803/api/create', { method: 'POST', body: JSON.stringify({ route: '/', note: 'n' }) })
    expect(r1.status).toBe(401)
    const r2 = await fetch('http://localhost:8803/api/create', {
      method: 'POST', headers: { 'x-overlay-token': 'wrong' }, body: JSON.stringify({ route: '/', note: 'n' }),
    })
    expect(r2.status).toBe(401)
  })
  it('GET /api/tags returns seeded tags with a correct token (query or header)', async () => {
    const { store } = boot(8804)
    store.upsert({ id: 'c1', route: '/', scope: 'element', selector: 'x', testid: null, textHint: '', note: 'n', createdAt: 1 })
    const r1 = await fetch('http://localhost:8804/api/tags?token=tok123')
    expect(r1.status).toBe(200)
    expect((await r1.json()).map((t: any) => t.id)).toEqual(['c1'])
    const r2 = await fetch('http://localhost:8804/api/tags', { headers: { 'x-overlay-token': 'tok123' } })
    expect(r2.status).toBe(200)
  })
  it('POST /api/resolve with unknown id 404s without broadcasting', async () => {
    boot(8805)
    const ws = new WebSocket('ws://localhost:8805/?token=tok123')
    await new Promise(res => ws.on('open', res))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(String(raw))))

    const res = await fetch('http://localhost:8805/api/resolve?token=tok123', { method: 'POST', body: JSON.stringify({ id: 'missing' }) })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown id' })

    await new Promise(r => setTimeout(r, 300))
    expect(received.filter(m => m.type === 'resolve')).toEqual([])
    ws.close()
  })
  it('POST /api/resolve with known id 200s and broadcasts to WS clients', async () => {
    const { store } = boot(8806)
    store.upsert({ id: 'c1', route: '/', scope: 'element', selector: 'x', testid: null, textHint: '', note: 'n', createdAt: 1 })
    const ws = new WebSocket('ws://localhost:8806/?token=tok123')
    await new Promise(res => ws.on('open', res))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(String(raw))))

    const res = await fetch('http://localhost:8806/api/resolve?token=tok123', { method: 'POST', body: JSON.stringify({ id: 'c1' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (received.some(m => m.type === 'resolve' && m.id === 'c1')) return resolve()
        if (Date.now() - start > 2000) return reject(new Error('timed out waiting for resolve broadcast'))
        setTimeout(check, 20)
      }
      check()
    })
    ws.close()
  })
  it('POST /api/create missing note 400s', async () => {
    boot(8807)
    const res = await fetch('http://localhost:8807/api/create?token=tok123', { method: 'POST', body: JSON.stringify({ route: '/' }) })
    expect(res.status).toBe(400)
  })
  it('POST /api/create with valid body 200s, tag has an a-prefixed id, and appears in GET /api/tags', async () => {
    boot(8808)
    const res = await fetch('http://localhost:8808/api/create?token=tok123', { method: 'POST', body: JSON.stringify({ route: '/', note: 'fix this' }) })
    expect(res.status).toBe(200)
    const tag = await res.json()
    expect(tag.id).toMatch(/^a/)
    expect(tag.note).toBe('fix this')

    const list = await (await fetch('http://localhost:8808/api/tags?token=tok123')).json()
    expect(list.map((t: any) => t.id)).toContain(tag.id)
  })
  it('port collision exits loudly', async () => {
    boot(8794)
    // listen() itself doesn't throw synchronously — EADDRINUSE arrives async via the
    // underlying http.Server's 'error' event, which cli.ts turns into a loud process.exit(1)
    // (see src/cli.ts). Swallow the one expected async error here so it doesn't fail the run.
    const onUncaught = (e: any) => { if (e?.code !== 'EADDRINUSE') throw e }
    process.on('uncaughtException', onUncaught)
    try {
      expect(() => startServer({ port: 8794, token: 't', store: new BridgeStore(mkdtempSync(path.join(tmpdir(), 'ovl-'))) }))
        .not.toThrow()
      await new Promise(r => setTimeout(r, 50))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
