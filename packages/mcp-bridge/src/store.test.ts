import { describe, it, expect, beforeEach } from 'vitest'
import { BridgeStore } from './store'
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'ovl-')) })

const tag = (id: string) => ({ id, route: '/', scope: 'element' as const, selector: 'x', testid: null, textHint: '', note: 'n', createdAt: 1 })

describe('BridgeStore', () => {
  it('persists upserts to tags.json and reloads', () => {
    const s = new BridgeStore(dir)
    s.upsert(tag('a'))
    const s2 = new BridgeStore(dir)
    expect(s2.list().map(t => t.id)).toEqual(['a'])
  })
  it('replaceAll mirrors the pushed set (extension wins on reconnect)', () => {
    const s = new BridgeStore(dir)
    s.upsert(tag('stale'))
    s.replaceAll([tag('fresh')])
    expect(s.list().map(t => t.id)).toEqual(['fresh'])
  })
  it('resolve marks status', () => {
    const s = new BridgeStore(dir)
    s.upsert(tag('a')); s.resolve('a')
    expect(s.list()[0].status).toBe('resolved')
  })
  it('create assigns agent id + origin', () => {
    const s = new BridgeStore(dir)
    const t = s.create({ route: '/x', note: 'do it', selector: '[data-testid="y"]' })
    expect(t.id[0]).toBe('a')
    expect(t.origin).toBe('agent')
    expect(t.scope).toBe('element')
  })
  it('saveShot writes a png and shotPath finds it', () => {
    const s = new BridgeStore(dir)
    s.saveShot('s1', Buffer.from('fakepng').toString('base64'))
    expect(s.shotPath('s1')).toContain('s1.png')
  })
  it('rejects path-traversal-shaped ids: shotPath returns null, saveShot no-ops', () => {
    const s = new BridgeStore(dir)
    s.saveShot('../evil', Buffer.from('fakepng').toString('base64'))
    expect(s.shotPath('../evil')).toBeNull()
    expect(existsSync(path.join(dir, 'evil.png'))).toBe(false)
    expect(existsSync(path.join(dir, '..', 'evil.png'))).toBe(false)
  })
  it('atomic write: no .tmp file after upsert, tags.json parses correctly', () => {
    const s = new BridgeStore(dir)
    s.upsert(tag('atomic-test'))
    const files = readdirSync(dir)
    expect(files).not.toContain('tags.json.tmp')
    expect(existsSync(path.join(dir, 'tags.json'))).toBe(true)
    const content = readFileSync(path.join(dir, 'tags.json'), 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed).toEqual([tag('atomic-test')])
  })
})
