import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import path from 'node:path'

export interface Tag {
  id: string; route: string; scope: 'element' | 'page'
  selector: string | null; testid: string | null; textHint: string
  note: string; createdAt: number
  status?: 'open' | 'resolved'; component?: string; screenshotId?: string
  origin?: 'user' | 'agent'
}

export class BridgeStore {
  private tags: Tag[] = []
  private file: string
  private shotsDir: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'tags.json')
    this.shotsDir = path.join(dir, 'screenshots')
    mkdirSync(this.shotsDir, { recursive: true })
    if (existsSync(this.file)) {
      try { this.tags = JSON.parse(readFileSync(this.file, 'utf8')) } catch { this.tags = [] }
    }
  }
  private save() {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.tags, null, 2))
    renameSync(tmp, this.file)
  }

  list() { return this.tags }
  upsert(tag: Tag) {
    const i = this.tags.findIndex(t => t.id === tag.id)
    if (i >= 0) this.tags[i] = tag; else this.tags.push(tag)
    this.save()
  }
  remove(id: string) { this.tags = this.tags.filter(t => t.id !== id); this.save() }
  replaceAll(tags: Tag[]) { this.tags = tags.slice(); this.save() }
  resolve(id: string): boolean {
    const t = this.tags.find(t => t.id === id)
    if (!t) return false
    t.status = 'resolved'
    this.save()
    return true
  }
  create(input: { route: string; note: string; selector?: string; scope?: 'element' | 'page' }): Tag {
    const tag: Tag = {
      id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      route: input.route, scope: input.scope ?? (input.selector ? 'element' : 'page'),
      selector: input.selector ?? null, testid: null, textHint: '',
      note: input.note, createdAt: Date.now(), origin: 'agent',
    }
    this.tags.push(tag); this.save()
    return tag
  }
  saveShot(id: string, base64: string) {
    if (!/^[a-z0-9]+$/i.test(id)) return   // reject path-traversal-shaped ids (e.g. '../evil') — no-op
    writeFileSync(path.join(this.shotsDir, id + '.png'), Buffer.from(base64, 'base64'))
  }
  shotPath(id: string): string | null {
    if (!/^[a-z0-9]+$/i.test(id)) return null   // reject path-traversal-shaped ids before touching the filesystem
    const p = path.join(this.shotsDir, id + '.png')
    return existsSync(p) ? p : null
  }
}
