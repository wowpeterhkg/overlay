// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStore } from './store.js'
import { localStorageAdapter } from './adapters.js'
import { mountOverlay as _mountOverlay, isExternalMutation } from './ui.js'

function freshStore(k) { localStorage.removeItem(k); return createStore(localStorageAdapter(k)) }

// Tests share one happy-dom document for the whole file. Several tests mount
// an overlay and never call destroy() themselves (not their concern), which
// used to leave live document-level listeners (keydown/click/mousemove)
// dangling across tests — invisible until a later test dispatches a global
// event (e.g. the Alt+A hotkey) and an earlier, still-"live" instance reacts.
// Track every instance created via mountOverlay and destroy() it after each
// test so tests stay isolated regardless of whether the test itself cleans up.
let liveOverlays = []
function mountOverlay(opts) {
  var ov = _mountOverlay(opts)
  liveOverlays.push(ov)
  return ov
}
afterEach(() => {
  liveOverlays.forEach(function (o) { try { o.destroy() } catch (e) { /* already torn down */ } })
  liveOverlays = []
})

describe('enrich seam', () => {
  it('merges the enrich patch into the captured tag', async () => {
    const store = freshStore('ut1')
    await store.ready
    const enrich = vi.fn().mockResolvedValue({ component: 'LoginForm', screenshotId: 's1' })
    const ov = mountOverlay({ store, preset: 'P', enrich })
    // simulate what captureEl's composer save does
    const target = document.createElement('button')
    document.body.appendChild(target)
    ov._captureForTest(target, 'make it blue')
    await new Promise(r => setTimeout(r, 0))
    const tag = store.list()[0]
    expect(enrich).toHaveBeenCalledWith(expect.objectContaining({ note: 'make it blue' }), target)
    expect(tag.component).toBe('LoginForm')
    expect(tag.screenshotId).toBe('s1')
  })

  it('capture survives enrich rejection', async () => {
    const store = freshStore('ut2')
    await store.ready
    const ov = mountOverlay({ store, preset: 'P', enrich: () => Promise.reject(new Error('nope')) })
    const target = document.createElement('div')
    document.body.appendChild(target)
    ov._captureForTest(target, 'still saved')
    await new Promise(r => setTimeout(r, 0))
    expect(store.list()[0].note).toBe('still saved')
  })
})

describe('agent pins', () => {
  it('renders origin:agent pins with ovl-pin-agent class', async () => {
    const store = freshStore('ut3')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'x')
    document.body.appendChild(target)
    store.add({ id: 'a1', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="x"]', testid: 'x', textHint: '', note: 'agent says', createdAt: 1, origin: 'agent' })
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    const pin = document.querySelector('.ovl-pin')
    expect(pin.className).toContain('ovl-pin-agent')
  })
})

describe('resolved tags', () => {
  it('hides the pin for a resolved tag but keeps it for an open one', async () => {
    const store = freshStore('ut4')
    await store.ready
    const open = document.createElement('div')
    open.setAttribute('data-testid', 'open-el')
    document.body.appendChild(open)
    const resolvedEl = document.createElement('div')
    resolvedEl.setAttribute('data-testid', 'resolved-el')
    document.body.appendChild(resolvedEl)
    store.add({ id: 'o1', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="open-el"]', testid: 'open-el', textHint: '', note: 'open note', createdAt: 1, status: 'open' })
    store.add({ id: 'r1', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="resolved-el"]', testid: 'resolved-el', textHint: '', note: 'resolved note', createdAt: 2, status: 'resolved' })
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    expect(document.querySelectorAll('.ovl-pin').length).toBe(1)

    store.update('o1', { status: 'resolved' })
    ov.render()
    expect(document.querySelectorAll('.ovl-pin').length).toBe(0)
  })
})

describe('resolved tags leave the panel', () => {
  it('panel list shows only the open tag; FAB shows count 1 not 2', async () => {
    const store = freshStore('ut4b')
    await store.ready
    const open = document.createElement('div')
    open.setAttribute('data-testid', 'open-el')
    document.body.appendChild(open)
    const resolvedEl = document.createElement('div')
    resolvedEl.setAttribute('data-testid', 'resolved-el')
    document.body.appendChild(resolvedEl)
    store.add({ id: 'o2', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="open-el"]', testid: 'open-el', textHint: '', note: 'open note', createdAt: 1, status: 'open' })
    store.add({ id: 'r2', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="resolved-el"]', testid: 'resolved-el', textHint: '', note: 'resolved note', createdAt: 2, status: 'resolved' })
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    expect(document.querySelectorAll('.ovl-row').length).toBe(1)
    const fab = document.querySelector('.ovl-fab')
    expect(fab.textContent).toContain('1')
    expect(fab.textContent).not.toContain('2')
  })

  it('resolving the last open tag via store + render() clears rows and pins', async () => {
    const store = freshStore('ut4c')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'only-el')
    document.body.appendChild(target)
    store.add({ id: 'o3', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="only-el"]', testid: 'only-el', textHint: '', note: 'note', createdAt: 1, status: 'open' })
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    expect(document.querySelectorAll('.ovl-row').length).toBe(1)
    expect(document.querySelectorAll('.ovl-pin').length).toBe(1)

    store.update('o3', { status: 'resolved' })
    ov.render()
    expect(document.querySelectorAll('.ovl-row').length).toBe(0)
    expect(document.querySelectorAll('.ovl-pin').length).toBe(0)
  })

  it('numbers remaining pins/rows from the open-tags list, no gap after an earlier resolve', async () => {
    const store = freshStore('ut4d')
    await store.ready
    const elA = document.createElement('div')
    elA.setAttribute('data-testid', 'el-a')
    document.body.appendChild(elA)
    const elB = document.createElement('div')
    elB.setAttribute('data-testid', 'el-b')
    document.body.appendChild(elB)
    // 'a' is created first (earlier) but resolved; 'b' is open and should become #1
    store.add({ id: 'a', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="el-a"]', testid: 'el-a', textHint: '', note: 'a note', createdAt: 1, status: 'resolved' })
    store.add({ id: 'b', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="el-b"]', testid: 'el-b', textHint: '', note: 'b note', createdAt: 2, status: 'open' })
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    const pin = document.querySelector('.ovl-pin')
    expect(pin.textContent).toBe('1')
    const num = document.querySelector('.ovl-num')
    expect(num.textContent).toBe('#1')
  })
})

describe('shot well', () => {
  function tagWithShot(id) {
    return { id, route: location.pathname + location.search, scope: 'element', selector: '[data-testid="x"]', testid: 'x', textHint: '', note: 'note', createdAt: 1, screenshotId: 'sh1' }
  }

  beforeEach(() => {
    // Floating bubbles live on document.body outside any per-test root, so a
    // prior test's open bubble (and its shot well) would otherwise leak into
    // the next test's DOM queries.
    Array.prototype.slice.call(document.querySelectorAll('.ovl-float, .ovl-shot')).forEach((e) => e.remove())
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    if (!window.ClipboardItem) { global.ClipboardItem = class ClipboardItem { constructor(obj) { this.obj = obj } } }
    if (!navigator.clipboard) { Object.defineProperty(navigator, 'clipboard', { value: { write: vi.fn().mockResolvedValue(undefined) }, configurable: true }) }
  })

  it('renders no .ovl-shot when getShot is not passed', async () => {
    const store = freshStore('utshot1')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'x')
    document.body.appendChild(target)
    const n = tagWithShot('w1')
    store.add(n)
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    const pin = document.querySelector('.ovl-pin')
    pin.click()
    expect(document.querySelector('.ovl-shot')).toBeNull()
  })

  it('calls getShot with the tag and renders the image; cropped:false shows the flag', async () => {
    const store = freshStore('utshot2')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'x')
    document.body.appendChild(target)
    const n = tagWithShot('w2')
    store.add(n)
    const getShot = vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,AAAA', cropped: false })
    const ov = mountOverlay({ store, preset: 'P', getShot })
    ov.render()
    const pin = document.querySelector('.ovl-pin')
    pin.click()
    expect(getShot).toHaveBeenCalledWith(expect.objectContaining({ id: 'w2' }))
    await new Promise(r => setTimeout(r, 0))
    const img = document.querySelector('.ovl-shot img')
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(document.querySelector('.ovl-shot-flag')).toBeTruthy()
  })

  it('copy click writes a ClipboardItem to the clipboard and flashes "copied"', async () => {
    const store = freshStore('utshot3')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'x')
    document.body.appendChild(target)
    const n = tagWithShot('w3')
    store.add(n)
    const getShot = vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,AAAA', cropped: true })
    const fakeBlob = { type: 'image/png' }
    global.fetch = vi.fn().mockResolvedValue({ blob: () => Promise.resolve(fakeBlob) })
    class FakeClipboardItem { constructor(obj) { this.obj = obj } }
    global.ClipboardItem = FakeClipboardItem
    const writeMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { write: writeMock }, configurable: true })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    const ov = mountOverlay({ store, preset: 'P', getShot })
    ov.render()
    const pin = document.querySelector('.ovl-pin')
    pin.click()
    await new Promise(r => setTimeout(r, 0))
    const btn = document.querySelector('.ovl-shot-copy')
    expect(btn).toBeTruthy()
    btn.click()
    await new Promise(r => setTimeout(r, 0))
    expect(writeMock).toHaveBeenCalled()
    const arg = writeMock.mock.calls[0][0][0]
    expect(arg).toBeInstanceOf(FakeClipboardItem)
    expect(btn.textContent).toBe('copied ✓')
  })

  it('removes the well entirely when getShot resolves null', async () => {
    const store = freshStore('utshot4')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'x')
    document.body.appendChild(target)
    const n = tagWithShot('w4')
    store.add(n)
    const getShot = vi.fn().mockResolvedValue(null)
    const ov = mountOverlay({ store, preset: 'P', getShot })
    ov.render()
    const pin = document.querySelector('.ovl-pin')
    pin.click()
    await new Promise(r => setTimeout(r, 0))
    expect(document.querySelector('.ovl-shot')).toBeNull()
  })
})

describe('destroy teardown', () => {
  it('removes pins + root, and a later body mutation does not resurrect pins (observer disconnected)', async () => {
    const store = freshStore('utd1')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'destroy-el')
    document.body.appendChild(target)
    store.add({ id: 'd1', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="destroy-el"]', testid: 'destroy-el', textHint: '', note: 'note', createdAt: 1 })
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    expect(document.querySelectorAll('.ovl-pin').length).toBe(1)
    expect(document.getElementById('overlay-root')).toBeTruthy()

    ov.destroy()
    expect(document.querySelector('.ovl-pin[data-ovl-id="d1"]')).toBeNull()
    expect(document.getElementById('overlay-root')).toBeNull()

    // A genuine external DOM mutation after destroy must not resurrect this
    // instance's pin — the MutationObserver must be disconnected. (Other
    // mountOverlay instances from earlier tests in this file may still be
    // observing document.body, so we scope the assertion to this test's own
    // tag id rather than the global .ovl-pin count.)
    const other = document.createElement('div')
    other.className = 'some-app-widget'
    document.body.appendChild(other)
    await new Promise((r) => setTimeout(r, 200))
    expect(document.querySelector('.ovl-pin[data-ovl-id="d1"]')).toBeNull()
  })

  it('the Alt+A hotkey does nothing after destroy', async () => {
    const store = freshStore('utd2')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'hotkey-dead-el')
    document.body.appendChild(target)
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    ov.destroy()

    // Spy on document.addEventListener from this point on: if destroy() left
    // the keydown listener attached, the hotkey below would run arm(), which
    // registers capture-phase 'click'/'mousemove' listeners. No such calls
    // should happen post-destroy.
    const addSpy = vi.spyOn(document, 'addEventListener')

    const e = new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(e)
    expect(document.querySelector('.ovl-fab.armed')).toBeNull()
    expect(document.getElementById('overlay-root')).toBeNull()
    expect(addSpy.mock.calls.some(([type]) => type === 'click' || type === 'mousemove')).toBe(false)

    // Even if a leaked keydown handler ran arm(), the resulting onHover/onPick
    // capture listeners would react to real DOM events. Dispatch both and
    // confirm neither the highlight box nor the floating composer (which
    // openComposer appends straight to document.body, bypassing the removed
    // root) ever appears — the actual resurrection path a listener leak takes.
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 0))
    const hilite = document.querySelector('.ovl-hilite')
    expect(!hilite || hilite.style.display === 'none').toBe(true)
    expect(document.querySelector('.ovl-float')).toBeNull()

    addSpy.mockRestore()
  })

  it('destroy is safe to call twice', async () => {
    const store = freshStore('utd3')
    await store.ready
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    expect(() => { ov.destroy(); ov.destroy(); }).not.toThrow()
  })

  it('re-mounting after destroy renders pins again', async () => {
    const store = freshStore('utd4')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'remount-el')
    document.body.appendChild(target)
    store.add({ id: 'd4', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="remount-el"]', testid: 'remount-el', textHint: '', note: 'note', createdAt: 1 })
    const ov1 = mountOverlay({ store, preset: 'P' })
    ov1.render()
    ov1.destroy()
    expect(document.querySelectorAll('.ovl-pin').length).toBe(0)

    const ov2 = mountOverlay({ store, preset: 'P' })
    ov2.render()
    expect(document.querySelectorAll('.ovl-pin').length).toBe(1)
    ov2.destroy()
  })
})

describe('pin flash fix', () => {
  it('renderPins reuses the same DOM node across renders when the store is unchanged', async () => {
    const store = freshStore('ut5')
    await store.ready
    const target = document.createElement('div')
    target.setAttribute('data-testid', 'stable-el')
    document.body.appendChild(target)
    store.add({ id: 's1', route: location.pathname + location.search, scope: 'element', selector: '[data-testid="stable-el"]', testid: 'stable-el', textHint: '', note: 'note', createdAt: 1 })
    const ov = mountOverlay({ store, preset: 'P' })
    ov.render()
    const before = document.querySelector('.ovl-pin[data-ovl-id="s1"]')
    expect(before).toBeTruthy()
    ov.render()
    const after = document.querySelector('.ovl-pin[data-ovl-id="s1"]')
    expect(after).toBe(before)
  })

  it('isExternalMutation ignores overlay-only childList mutations (pin/hilite/float churn)', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const pin = document.createElement('div')
    pin.className = 'ovl-pin'
    const hilite = document.createElement('div')
    hilite.className = 'ovl-hilite'
    const overlayOnlyMutation = {
      type: 'childList',
      target: document.body,
      addedNodes: [pin],
      removedNodes: [hilite],
    }
    expect(isExternalMutation(overlayOnlyMutation, root)).toBe(false)
  })

  it('isExternalMutation treats a mutation with a non-overlay node as external', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const pin = document.createElement('div')
    pin.className = 'ovl-pin'
    const appNode = document.createElement('div')
    appNode.className = 'some-app-widget'
    const mixedMutation = {
      type: 'childList',
      target: document.body,
      addedNodes: [pin, appNode],
      removedNodes: [],
    }
    expect(isExternalMutation(mixedMutation, root)).toBe(true)
  })

  it('isExternalMutation ignores mutations whose target is inside root', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const child = document.createElement('div')
    root.appendChild(child)
    const mutation = { type: 'childList', target: child, addedNodes: [], removedNodes: [] }
    expect(isExternalMutation(mutation, root)).toBe(false)
  })

  it('isExternalMutation treats attribute mutations on non-overlay targets as external', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const appNode = document.createElement('div')
    document.body.appendChild(appNode)
    const mutation = { type: 'attributes', target: appNode, addedNodes: [], removedNodes: [] }
    expect(isExternalMutation(mutation, root)).toBe(true)
  })
})
