import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs'
import * as esbuild from 'esbuild'
import { test, expect } from './fixtures'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bridgeSrcDir = path.resolve(__dirname, '../packages/mcp-bridge/src')

const BRIDGE_PORT = 8799
const TOKEN = 'e2e-sync-token'
const STATIC_PORT = 5185
const STATIC_HTML = '<html><body><h1 id="hero">Hello</h1></body></html>'

type BridgeModule = {
  startServer(opts: { port: number; token: string; store: any }): { close(): Promise<void>; broadcast(msg: object): void }
  BridgeStore: new (dir: string) => any
}

// Loads the real bridge source (not a mock) by bundling it with esbuild at
// test time and dynamic-importing the result — same technique used in
// extension.spec.ts for the React fixture bundle. This exercises the actual
// server.ts/store.ts code the CLI ships, in-process, so the test can also
// call `handle.broadcast()` directly to simulate the Down-message pushes
// that Task 12's MCP tools will eventually trigger.
async function loadBridge(): Promise<BridgeModule> {
  const result = esbuild.buildSync({
    stdin: {
      contents: `export { startServer } from './server'\nexport { BridgeStore } from './store'`,
      resolveDir: bridgeSrcDir,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['ws'],
    write: false,
  })
  // Written inside packages/mcp-bridge (not os.tmpdir()) so the bundle's
  // `import 'ws'` resolves via the monorepo's hoisted root node_modules —
  // Node's bare-specifier resolution walks up from the importing file's own
  // directory, which a bundle under os.tmpdir() has no path back from.
  const tmpFile = path.join(bridgeSrcDir, `.e2e-bundle-${Date.now()}.mjs`)
  writeFileSync(tmpFile, result.outputFiles[0].text)
  bundleFile = tmpFile
  return import(pathToFileURL(tmpFile).href)
}

let staticServer: Server
let bridge: BridgeModule
let store: any
let handle: { close(): Promise<void>; broadcast(msg: object): void }
let bundleFile: string | undefined

test.beforeAll(async () => {
  staticServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(STATIC_HTML)
  })
  await new Promise<void>((resolve) => staticServer.listen(STATIC_PORT, resolve))

  bridge = await loadBridge()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovl-store-'))
  store = new bridge.BridgeStore(dir)
  handle = bridge.startServer({ port: BRIDGE_PORT, token: TOKEN, store })
})

test.afterAll(async () => {
  await handle.close()
  await new Promise<void>((resolve) => staticServer.close(() => resolve()))
  if (bundleFile) try { unlinkSync(bundleFile) } catch { /* best effort cleanup */ }
})

test('extension pairs via /pair, mirrors a captured tag up, and applies bridge downs', async ({ context }) => {
  // 1. Pair: real navigation to the real bridge's /pair page, real marker read.
  const pairPage = await context.newPage()
  await pairPage.goto(`http://localhost:${BRIDGE_PORT}/pair`)
  await expect(pairPage.locator('#ovl-pair')).toContainText('✓ Paired.')
  await pairPage.close()

  const worker = context.serviceWorkers()[0]
  const cfg = await worker.evaluate(() => chrome.storage.local.get(['ovl_token', 'ovl_port']))
  expect(cfg.ovl_token).toBe(TOKEN)
  expect(cfg.ovl_port).toBe(BRIDGE_PORT)

  // 2. Connection: the SW should now be connected to the bridge; the content
  // script's status chip (polling every 5s) is the observable proof.
  const page = await context.newPage()
  await page.goto(`http://localhost:${STATIC_PORT}/`)
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()
  await expect(page.locator('.ovl-bridge-chip')).toHaveText('⇅ bridge', { timeout: 8_000 })

  // 3. Up: a real user capture should mirror to the bridge as a delta and
  // land in its on-disk store.
  await page.keyboard.press('Alt+a')
  await page.locator('#hero').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('sync check')
  await page.locator('.ovl-float .ovl-act-primary').click()
  await expect(page.locator('.ovl-pin')).toHaveCount(1)

  await expect.poll(() => store.list().length).toBe(1)
  const upstreamTag = store.list()[0]
  expect(upstreamTag.note).toBe('sync check')
  expect(upstreamTag.selector).toBe('#hero')
  // (on-disk durability of BridgeStore.save() is already covered by store.test.ts)

  // 4. Down — resolve: bridge pushes a resolve for the tag we just mirrored up.
  handle.broadcast({ type: 'resolve', id: upstreamTag.id })
  await expect.poll(async () => {
    const v = await worker.evaluate(() => chrome.storage.local.get('overlay_tags'))
    const tags = JSON.parse((v as any).overlay_tags ?? '[]')
    return tags.find((t: any) => t.id === upstreamTag.id)?.status
  }).toBe('resolved')

  // 5. Down — create: bridge pushes a brand-new agent-authored tag; content
  // script's onChanged listener should pick it up and render a new pin.
  handle.broadcast({
    type: 'create',
    tag: {
      id: 'agent-sync-1', route: '/', scope: 'element', selector: '#hero', testid: null,
      textHint: 'Hello', note: 'agent pushed this', createdAt: Date.now(), origin: 'agent',
    },
  })
  await expect(page.locator('.ovl-pin-agent')).toHaveCount(1)

  // 6. Re-pair: navigating /pair again triggers the SW's 'ovl-paired' handler
  // (ws?.close(); connect()), which races the old socket's async onclose
  // against the new socket being assigned to the shared `ws` var. If the
  // stale socket's onclose isn't guarded, it can null out the live socket,
  // clear its keepalive, and schedule a duplicate reconnect (remedy 1).
  const repairPage = await context.newPage()
  await repairPage.goto(`http://localhost:${BRIDGE_PORT}/pair`)
  await expect(repairPage.locator('#ovl-pair')).toContainText('✓ Paired.')
  await repairPage.close()

  await expect(page.locator('.ovl-bridge-chip')).toHaveText('⇅ bridge', { timeout: 8_000 })

  const tagCountBefore = store.list().length

  // 7. Prove the NEW socket (post re-pair) is the one actually live and
  // managed: capture one more tag and confirm it reaches the bridge store.
  await page.keyboard.press('Alt+a')
  await page.locator('#hero').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('after re-pair')
  await page.locator('.ovl-float .ovl-act-primary').click()

  await expect.poll(() => store.list().length).toBe(tagCountBefore + 1)
  const rePairTag = store.list().find((t: any) => t.note === 'after re-pair')
  expect(rePairTag).toBeTruthy()

  // Soft check for remedy 2 (Down→Up echo suppression): the exact expected
  // count with no extra entries rules out a spurious upsert storm from a
  // stale-socket duplicate connection or an echoed Down.
  expect(store.list().length).toBe(tagCountBefore + 1)
})
