import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { test, expect } from './fixtures'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const STATIC_PORT = 5178
const STATIC_HTML = '<html><body><h1 id="hero">Hello</h1></body></html>'

let staticServer: Server

// A second plain-HTML server hosting a tiny, real React 18 tree (bundled at
// test time from demo's node_modules — no changes to demo/ itself). Unlike
// :5199 (the demo dev server), this page has no vite-plugin overlay, so the
// extension's own content-script mount is guaranteed to win the race and its
// enrich/fiber-probe wiring is what actually captures the tag.
const REACT_PORT = 5180
let reactServer: Server

function buildReactBundle(): string {
  const result = esbuild.buildSync({
    stdin: {
      contents: `
        const React = require('react')
        const { createRoot } = require('react-dom/client')
        function Cta() {
          return React.createElement('button', { 'data-testid': 'cta-button' }, 'Click me')
        }
        function ProbeHome() {
          return React.createElement('main', null, React.createElement(Cta, null))
        }
        createRoot(document.getElementById('root')).render(React.createElement(ProbeHome, null))
      `,
      resolveDir: path.resolve(__dirname, '../demo'),
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  })
  return result.outputFiles[0].text
}

test.beforeAll(async () => {
  staticServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(STATIC_HTML)
  })
  await new Promise<void>((resolve) => staticServer.listen(STATIC_PORT, resolve))

  const reactBundle = buildReactBundle()
  reactServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><body><div id="root"></div><script>${reactBundle}</script></body></html>`)
  })
  await new Promise<void>((resolve) => reactServer.listen(REACT_PORT, resolve))
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => staticServer.close(() => resolve()))
  await new Promise<void>((resolve) => reactServer.close(() => resolve()))
})

test('extension loads and SW runs', async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/)
})

test('popup reports tag count', async ({ context, extensionId }) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)
  await expect(page.locator('#count')).not.toHaveText('–')
})

test('content script mounts overlay on localhost (no vite plugin needed)', async ({ context }) => {
  const page = await context.newPage()
  await page.goto('http://localhost:5199/')
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()
})

test('vite-plugin + extension do not double-mount', async ({ context }) => {
  const page = await context.newPage()
  await page.goto('http://localhost:5199/')
  await page.waitForTimeout(500)
  expect(await page.locator('#overlay-root').count()).toBe(1)
})

test('capture persists to chrome.storage and an external write re-renders pins', async ({ context }) => {
  const page = await context.newPage()
  await page.goto(`http://localhost:${STATIC_PORT}/`)
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()

  // Real user path: arm via hotkey, hover the target, capture with Enter,
  // type a note in the composer, confirm.
  await page.keyboard.press('Alt+a')
  await page.locator('#hero').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('fix the heading')
  await page.locator('.ovl-float .ovl-act-primary').click()
  await expect(page.locator('.ovl-pin')).toHaveCount(1)

  // Persistence: read the extension's own storage via the service worker
  // (the content script's isolated-world DOM has no direct chrome.storage
  // access from the test process).
  const worker = context.serviceWorkers()[0]
  const stored = await worker.evaluate(async () => {
    const result = await chrome.storage.local.get('overlay_tags')
    return JSON.parse(result.overlay_tags ?? '[]')
  })
  expect(stored).toHaveLength(1)
  expect(stored[0].note).toBe('fix the heading')
  expect(stored[0].selector).toBe('#hero')

  // External write (simulating a bridge/agent write via the service worker) →
  // onChanged fires in the content script → reload() + render() should pick
  // up the new tag without any action in this page. Playwright's auto-wait on
  // toHaveCount proves the reload/re-render round-trip actually happened.
  await worker.evaluate(async (existing) => {
    const next = existing.concat([{
      id: 'agent-1',
      route: '/',
      scope: 'element',
      selector: '#hero',
      testid: null,
      textHint: 'Hello',
      note: 'agent-added tag',
      origin: 'agent',
      createdAt: Date.now(),
    }])
    await chrome.storage.local.set({ overlay_tags: JSON.stringify(next) })
  }, stored)

  await expect(page.locator('.ovl-pin')).toHaveCount(2)
  await expect(page.locator('.ovl-pin-agent')).toHaveCount(1)
})

test('kill switch actually kills: mounted overlay + pin unmount, stay unmounted through DOM churn, and remount when cleared', async ({ context }) => {
  const page = await context.newPage()
  await page.goto(`http://localhost:${STATIC_PORT}/`)
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()

  // Capture a tag so we have a pin to watch disappear/reappear.
  await page.keyboard.press('Alt+a')
  await page.locator('#hero').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('kill switch check')
  await page.locator('.ovl-float .ovl-act-primary').click()
  await expect(page.locator('.ovl-pin')).toHaveCount(1)

  // Flip the per-origin kill switch via chrome.storage.local, same channel
  // the popup uses — content.ts's onChanged listener should unmount in place.
  const worker = context.serviceWorkers()[0]
  const origin = await page.evaluate(() => location.origin)
  await worker.evaluate(async (origin) => {
    await chrome.storage.local.set({ ovl_off_origins: [origin] })
  }, origin)

  await expect(page.locator('#overlay-root')).toHaveCount(0)
  await expect(page.locator('.ovl-pin')).toHaveCount(0)

  // A genuine external DOM mutation must not resurrect the pin — the old bug
  // was mountOverlay's MutationObserver (watching document.body, outside the
  // removed root) staying alive and re-appending pins to <body>.
  await page.evaluate(() => {
    const div = document.createElement('div')
    div.textContent = 'unrelated app content'
    document.body.appendChild(div)
  })
  await page.waitForTimeout(300)
  await expect(page.locator('#overlay-root')).toHaveCount(0)
  await expect(page.locator('.ovl-pin')).toHaveCount(0)

  // Clearing the kill switch remounts in place and the pin returns.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ ovl_off_origins: [] })
  })
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()
  await expect(page.locator('.ovl-pin')).toHaveCount(1)
})

test('captured tag records React component name', async ({ context }) => {
  // :5199 (the demo dev server) always has vite-plugin's own overlay mounted
  // before the extension's document_idle content script runs, so content.ts
  // never mounts there and its enrich/probe wiring is never exercised — the
  // guard in content.ts (`if (document.getElementById('overlay-root')) return`)
  // deliberately no-ops in that case. Use the plain React page above instead,
  // where the extension is the only overlay and the fiber probe is live.
  const page = await context.newPage()
  await page.goto(`http://localhost:${REACT_PORT}/`)
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()
  await page.keyboard.press('Alt+a')
  await page.locator('[data-testid="cta-button"]').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('component check')
  await page.locator('.ovl-float .ovl-act-primary').click()
  await expect
    .poll(async () => {
      const worker = context.serviceWorkers()[0]
      const v = await worker.evaluate(() => chrome.storage.local.get('overlay_tags'))
      return (v as Record<string, unknown>)['overlay_tags']
    })
    .toContain('"component"')
})

test('captured tag stores a cropped screenshot', async ({ context }) => {
  const page = await context.newPage()
  await page.goto(`http://localhost:${REACT_PORT}/`)
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()
  await page.keyboard.press('Alt+a')
  await page.locator('[data-testid="cta-button"]').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('shot check')
  await page.locator('.ovl-float .ovl-act-primary').click()
  const worker = context.serviceWorkers()[0]
  await expect.poll(() =>
    worker.evaluate(async () => {
      const v = await chrome.storage.local.get('overlay_tags')
      return v['overlay_tags'] as string
    })
  ).toContain('"screenshotId"')

  const stored = await worker.evaluate(async () => {
    const result = await chrome.storage.local.get('overlay_tags')
    return JSON.parse(result.overlay_tags ?? '[]')
  })
  const tag = stored.find((t: { screenshotId?: string }) => t.screenshotId)
  expect(tag).toBeTruthy()

  const rect = await page.locator('[data-testid="cta-button"]').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { w: r.width, h: r.height, dpr: window.devicePixelRatio }
  })

  const png = await worker.evaluate(async (id: string) => {
    const dbReq = indexedDB.open('ovl-shots', 1)
    const db = await new Promise<IDBDatabase>((res, rej) => {
      dbReq.onsuccess = () => res(dbReq.result)
      dbReq.onerror = () => rej(dbReq.error)
    })
    const rec = await new Promise<{ blob: Blob; cropped: boolean }>((res, rej) => {
      const req = db.transaction('shots').objectStore('shots').get(id)
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const buf = await rec.blob.arrayBuffer()
    const bytes = Array.from(new Uint8Array(buf))
    return { bytes, cropped: rec.cropped, type: rec.blob.type }
  }, tag.screenshotId)

  expect(png.type).toBe('image/png')
  // PNG signature
  expect(png.bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(png.cropped).toBe(true)

  // IHDR chunk: width/height are big-endian uint32 at bytes 16-23
  const buf = Buffer.from(png.bytes)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  expect(width).toBe(Math.round(rect.w * rect.dpr))
  expect(height).toBe(Math.round(rect.h * rect.dpr))
})
