import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from './store.js'
import { localStorageAdapter, asyncAdapter } from './adapters.js'

function fakeLS() {
  let m = {}
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v) },
    removeItem: k => { delete m[k] },
  }
}

beforeEach(() => { globalThis.localStorage = fakeLS() })

const tag = (over = {}) => ({
  id: 'c1', route: '/', scope: 'element', selector: '[data-testid="x"]',
  testid: 'x', textHint: 'hint', note: 'fix it', createdAt: 1, ...over,
})

describe('createStore', () => {
  it('starts empty and survives corrupt JSON', async () => {
    localStorage.setItem('k', '{nope')
    const s = createStore(localStorageAdapter('k'))
    await s.ready
    expect(s.list()).toEqual([])
  })
  it('add persists under storageKey', async () => {
    const s = createStore(localStorageAdapter('k'))
    await s.ready
    s.add(tag())
    await s.flushed()
    expect(JSON.parse(localStorage.getItem('k'))).toHaveLength(1)
    const s2 = createStore(localStorageAdapter('k'))
    await s2.ready
    expect(s2.list()[0].note).toBe('fix it')
  })
  it('update patches by id', async () => {
    const s = createStore(localStorageAdapter('k'))
    await s.ready
    s.add(tag())
    s.update('c1', { note: 'new' })
    expect(s.list()[0].note).toBe('new')
  })
  it('removeById deletes', async () => {
    const s = createStore(localStorageAdapter('k'))
    await s.ready
    s.add(tag()); s.removeById('c1')
    expect(s.list()).toEqual([])
  })
  it('resolveById sets status, openTags filters it', async () => {
    const s = createStore(localStorageAdapter('k'))
    await s.ready
    s.add(tag()); s.add(tag({ id: 'c2' }))
    s.resolveById('c1')
    expect(s.list()).toHaveLength(2)
    expect(s.openTags().map(t => t.id)).toEqual(['c2'])
  })
  it('clear empties', async () => {
    const s = createStore(localStorageAdapter('k'))
    await s.ready
    s.add(tag()); s.clear()
    expect(s.list()).toEqual([])
  })
})

describe('adapter store', () => {
  it('starts empty before ready, loads after ready (async adapter)', async () => {
    let disk = JSON.stringify([{ id: 'x1', note: 'n' }])
    const s = createStore(asyncAdapter({
      get: async () => disk,
      set: async (v) => { disk = v },
    }))
    expect(s.list()).toEqual([])          // sync construction, empty until ready
    await s.ready
    expect(s.list().length).toBe(1)
  })

  it('persists through the adapter', async () => {
    let disk = '[]'
    const s = createStore(asyncAdapter({ get: async () => disk, set: async (v) => { disk = v } }))
    await s.ready
    s.add({ id: 'a', note: 'hi' })
    await s.flushed()
    expect(JSON.parse(disk)[0].id).toBe('a')
  })

  it('reload replaces in-memory tags from the adapter', async () => {
    let disk = '[]'
    const s = createStore(asyncAdapter({ get: async () => disk, set: async (v) => { disk = v } }))
    await s.ready
    disk = JSON.stringify([{ id: 'ext', note: 'from elsewhere' }])
    await s.reload()
    expect(s.list()[0].id).toBe('ext')
  })

  it('localStorageAdapter round-trips', async () => {
    localStorage.setItem('lk', JSON.stringify([{ id: 'p' }]))
    const s = createStore(localStorageAdapter('lk'))
    await s.ready
    expect(s.list()[0].id).toBe('p')
    s.clear()
    await s.flushed()
    expect(localStorage.getItem('lk')).toBe('[]')
  })

  it('load rejection falls back to empty list without rejecting ready', async () => {
    const s = createStore(asyncAdapter({
      get: () => Promise.reject(new Error('boom')),
      set: async () => {},
    }))
    await expect(s.ready).resolves.toBeUndefined()
    expect(s.list()).toEqual([])
  })

  it('a sync-throwing adapter.load does not crash createStore', async () => {
    const adapter = {
      load: () => { throw new Error('sync boom') },
      save: () => {},
    }
    const s = createStore(adapter)
    await s.ready
    expect(s.list()).toEqual([])
  })

  it('serializes concurrent saves; second save waits for first to settle', async () => {
    const log = []
    let resolveFirst
    const adapter = {
      load: () => [],
      save: (tags) => {
        log.push('save-start:' + tags.length)
        return new Promise((resolve) => {
          if (!resolveFirst) resolveFirst = resolve
          else resolve()
        })
      },
    }
    const s = createStore(adapter)
    await s.ready
    s.add(tag({ id: 'c1' }))
    // let the first save actually reach the adapter before mutating again
    for (let i = 0; i < 10 && log.length === 0; i++) await Promise.resolve()
    expect(log).toEqual(['save-start:1'])
    s.add(tag({ id: 'c2' }))
    // second save must not start while the first is still in flight
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(log).toEqual(['save-start:1'])
    resolveFirst()
    await s.flushed()
    expect(log).toEqual(['save-start:1', 'save-start:2'])
  })

  it('a mutation issued before the initial load resolves wins over the stale load', async () => {
    let resolveLoad
    const adapter = {
      load: () => new Promise((resolve) => { resolveLoad = resolve }),
      save: async () => {},
    }
    const s = createStore(adapter)
    s.add(tag({ id: 'new' }))
    resolveLoad([{ id: 'old' }])
    await s.ready
    const ids = s.list().map((t) => t.id)
    expect(ids).toContain('new')
    expect(ids).not.toContain('old')
  })
})
