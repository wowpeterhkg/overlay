import { test, expect } from './fixtures'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import type { Server } from 'node:http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let bridge: ChildProcess
let dir: string
const PORT = 8797

// A plain static page (no vite-plugin) hosting the same `cta-button` testid
// as the demo. localhost:5199 is the demo dev server, and it always has the
// vite-plugin's own overlay mounted before the extension's document_idle
// content script runs — content.ts's `if (document.getElementById('overlay-root'))
// return` guard deliberately no-ops there (see extension.spec.ts's "captured
// tag records React component name" test for the same constraint). This
// spec is proving the extension's own capture → real spawned bridge → downs
// round trip, so it needs a page where the extension actually owns the
// overlay — same pattern extension.spec.ts and sync.spec.ts already use.
const STATIC_PORT = 5187
const STATIC_HTML = '<html><body><button data-testid="cta-button">Click me</button></body></html>'
let staticServer: Server

test.beforeAll(async () => {
  staticServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(STATIC_HTML)
  })
  await new Promise<void>((resolve) => staticServer.listen(STATIC_PORT, resolve))

  dir = mkdtempSync(path.join(tmpdir(), 'ovl-rt-'))
  bridge = spawn('node', [path.resolve(__dirname, '../packages/mcp-bridge/dist/cli.js'), '--dir', dir, '--port', String(PORT), '--test-http'], { stdio: ['ignore', 'pipe', 'pipe'] })

  // Diagnostics: if the bridge process fails to spawn or never comes up, fail
  // fast with the captured stderr instead of letting the first test's actions
  // time out opaquely with no clue why.
  let spawnError: Error | null = null
  let stderr = ''
  bridge.on('error', (e) => { spawnError = e })
  bridge.stderr?.on('data', (c) => { stderr += c.toString() })

  const deadline = Date.now() + 10_000
  let ready = false
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`overlay bridge process failed to spawn: ${spawnError.message}\nstderr:\n${stderr}`)
    try {
      const res = await fetch(`http://localhost:${PORT}/pair`)
      if (res.ok) { ready = true; break }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!ready) {
    throw new Error(`overlay bridge did not become ready on port ${PORT} within 10s\nstderr:\n${stderr}`)
  }
})
test.afterAll(async () => {
  await new Promise<void>((resolve) => staticServer.close(() => resolve()))
  if (bridge.pid == null) return
  // Windows: a plain child.kill() often fails to actually terminate a
  // spawned `node` process (no POSIX signals) — fall back to taskkill.
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${bridge.pid} /T /F`) } catch { /* already gone */ }
  } else {
    bridge.kill()
  }
})

test('tag flows to bridge; resolve flows back live; create_tag renders an agent pin', async ({ context }) => {
  // 1. pair
  const pairPage = await context.newPage()
  await pairPage.goto(`http://localhost:${PORT}/pair`)
  await expect(pairPage.locator('#ovl-pair')).toContainText('Paired')

  // 2. capture a tag on the demo
  const page = await context.newPage()
  await page.goto(`http://localhost:${STATIC_PORT}/`)
  await expect(page.locator('.ovl-bridge-chip')).toHaveText('⇅ bridge', { timeout: 8_000 })
  await page.keyboard.press('Alt+a')
  await page.locator('[data-testid="cta-button"]').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('roundtrip tag')
  await page.locator('.ovl-float .ovl-act-primary').click()
  await expect(page.locator('.ovl-pin')).toBeVisible()

  // 3. bridge mirrored it to disk
  await expect.poll(() => {
    const f = path.join(dir, 'tags.json')
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }).toContain('roundtrip tag')

  // 3b. the enrich patch (screenshotId) reaches the bridge as actual image
  // bytes on disk — proving the sw.ts delta loop's "screenshotId newly
  // appeared" gate (not just the initial store.add write) pushes the shot.
  // Capture is two writes (store.add, then the enrich store.update a beat
  // later), so screenshotId lands on tags.json asynchronously after the
  // 'roundtrip tag' text above — poll for it rather than reading once. If it
  // never appears, that's a genuine bug worth investigating, not something
  // to paper over with a skip.
  const readCapturedTag = () => JSON.parse(readFileSync(path.join(dir, 'tags.json'), 'utf8'))[0]
  await expect.poll(() => readCapturedTag().screenshotId, {
    timeout: 10_000,
    message: 'captured tag never got a screenshotId — enrich did not attach one',
  }).toBeTruthy()
  const capturedTag = readCapturedTag()
  const screenshotId = capturedTag.screenshotId
  await expect.poll(() => existsSync(path.join(dir, 'screenshots', `${screenshotId}.png`)), { timeout: 10_000 }).toBe(true)

  // 4. resolve via the bridge's test endpoint (same internal path as the MCP tool)
  const id = capturedTag.id
  await fetch(`http://localhost:${PORT}/__test/resolve`, { method: 'POST', body: JSON.stringify({ id }), headers: { 'content-type': 'application/json' } })

  // 5. resolve flows back live in the browser: the bridge broadcasts a
  // 'resolve' Down over the same socket the capture went up on, and the
  // service worker applies it to its own storage — proving the Down actually
  // reached the live extension, not just the bridge's on-disk copy.
  const worker = context.serviceWorkers()[0]
  await expect.poll(async () => {
    const v = await worker.evaluate(() => chrome.storage.local.get('overlay_tags'))
    const tags = JSON.parse((v as any).overlay_tags ?? '[]')
    return tags.find((t: any) => t.id === id)?.status
  }, { timeout: 5_000 }).toBe('resolved')

  // renderPins() now skips resolved tags, so the pin itself must disappear
  // from the DOM, not just the underlying storage record.
  await expect(page.locator('.ovl-pin')).toHaveCount(0)

  // 6. create_tag path: test endpoint POST /__test/create {route, note} → agent pin appears
  await fetch(`http://localhost:${PORT}/__test/create`, { method: 'POST', body: JSON.stringify({ route: '/', note: 'agent-made', selector: '[data-testid="cta-button"]' }), headers: { 'content-type': 'application/json' } })
  await expect(page.locator('.ovl-pin-agent')).toBeVisible({ timeout: 5_000 })
})
