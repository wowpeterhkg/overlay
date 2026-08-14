import { describe, it, expect, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from './mcp'
import { BridgeStore } from './store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let store: BridgeStore
let client: Client
let broadcasts: object[]

beforeEach(async () => {
  store = new BridgeStore(mkdtempSync(path.join(tmpdir(), 'ovl-')))
  broadcasts = []
  const server = buildMcpServer(store, { broadcast: (m: object) => broadcasts.push(m) })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(ct)
})

const tag = (id: string, extra = {}) => ({ id, route: '/', scope: 'element' as const, selector: '[data-testid="x"]', testid: 'x', textHint: 'Click', note: 'fix', createdAt: 1, ...extra })

describe('MCP tools', () => {
  it('list_tags returns open tags with screenshot flag', async () => {
    store.upsert(tag('c1', { screenshotId: 's1' }))
    store.upsert(tag('c2', { status: 'resolved' }))
    const r: any = await client.callTool({ name: 'list_tags', arguments: {} })
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.length).toBe(1)
    expect(parsed[0].hasScreenshot).toBe(false) // s1.png not written
  })
  it('list_tags includeResolved + route filter', async () => {
    store.upsert(tag('c1')); store.upsert(tag('c2', { route: '/other', status: 'resolved' }))
    const r: any = await client.callTool({ name: 'list_tags', arguments: { route: '/other', includeResolved: true } })
    expect(JSON.parse(r.content[0].text).length).toBe(1)
  })
  it('get_screenshot returns image content', async () => {
    store.upsert(tag('c1', { screenshotId: 's1' }))
    store.saveShot('s1', Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
    const r: any = await client.callTool({ name: 'get_screenshot', arguments: { id: 's1' } })
    expect(r.content[0].type).toBe('image')
    expect(r.content[0].mimeType).toBe('image/png')
  })
  it('get_screenshot with a path-traversal id errors without touching the filesystem', async () => {
    const r: any = await client.callTool({ name: 'get_screenshot', arguments: { id: '../evil' } })
    expect(r.isError).toBe(true)
  })
  it('resolve_tag marks store + broadcasts down', async () => {
    store.upsert(tag('c1'))
    await client.callTool({ name: 'resolve_tag', arguments: { id: 'c1' } })
    expect(store.list()[0].status).toBe('resolved')
    expect(broadcasts).toContainEqual({ type: 'resolve', id: 'c1' })
  })
  it('resolve_tag with unknown id errors without broadcasting', async () => {
    const r: any = await client.callTool({ name: 'resolve_tag', arguments: { id: 'missing' } })
    expect(r.isError).toBe(true)
    expect(broadcasts.length).toBe(0)
  })
  it('create_tag creates agent tag + broadcasts down', async () => {
    const r: any = await client.callTool({ name: 'create_tag', arguments: { route: '/', note: 'add spacing' } })
    const t = JSON.parse(r.content[0].text)
    expect(t.origin).toBe('agent')
    expect(broadcasts[0]).toMatchObject({ type: 'create' })
  })
})
