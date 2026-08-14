import { createStore } from './store.js'
import { localStorageAdapter, asyncAdapter } from './adapters.js'
import { mountOverlay } from './ui.js'

export { createStore, localStorageAdapter, asyncAdapter, mountOverlay }

export interface TagSource { file: string; line: number; column?: number }
export interface Tag {
  id: string
  route: string
  scope: 'element' | 'page'
  selector: string | null
  testid: string | null
  textHint: string
  note: string
  createdAt: number
  status?: 'open' | 'resolved'
  source?: TagSource
  component?: string
  screenshotId?: string
  origin?: 'user' | 'agent'
}

export interface OverlayConfig {
  /** Fix-prompt text prepended to the clipboard export. */
  preset?: string
  /** localStorage key. Default: 'overlay_tags' */
  storageKey?: string
  /** Arm shortcut. Default: 'Alt+A' */
  hotkey?: string
}

export const DEFAULT_PRESET = [
  'UI feedback — address the tagged items below.',
  '',
  'These are change requests captured on the running app with a review overlay. ' +
  'Each tag is one requested change, grouped by route/page. Per line: `sel=` is a ' +
  'selector into the live DOM (data-testid preferred), `text=` is nearby text for ' +
  'orientation, and the quoted note is the requested change. `sel=(whole page)` ' +
  'means the note is about the whole page or its layout.',
  '',
  'Do this:',
  '1. Find the real source (component/file) behind each selector — edit source, never the DOM.',
  '2. Make the change the note asks for; match existing styles, tokens and patterns.',
  '3. Keep edits minimal and scoped; work route by route.',
  '',
  'Tags:',
].join('\n')

let instance: { toggle(): void } | null = null

export function init(config: OverlayConfig = {}): void {
  if (instance) { instance.toggle(); return }
  const store = createStore(localStorageAdapter(config.storageKey ?? 'overlay_tags'))
  store.ready.then(() => {
    instance = mountOverlay({
      store,
      preset: config.preset ?? DEFAULT_PRESET,
      hotkey: config.hotkey ?? 'Alt+A',
    })
  })
}
