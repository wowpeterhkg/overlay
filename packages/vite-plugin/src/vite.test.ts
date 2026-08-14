import { describe, it, expect } from 'vitest'
import overlay from './vite'

function transform(plugin: ReturnType<typeof overlay>, html: string): string {
  const hook = plugin.transformIndexHtml
  const fn = typeof hook === 'function' ? hook : (hook as { handler: Function }).handler
  return (fn as Function)(html)
}

describe('overlay vite plugin', () => {
  it('is serve-only', () => {
    expect(overlay().apply).toBe('serve')
  })
  it('injects init script before </body>', () => {
    const out = transform(overlay(), '<html><body><div id="app"></div></body></html>')
    expect(out).toContain("import { init } from '@idnerd/overlay'")
    expect(out).toContain('import.meta.env.DEV')
    expect(out.indexOf('init(')).toBeLessThan(out.indexOf('</body>'))
  })
  it('serializes only user-provided options', () => {
    const out = transform(overlay({ storageKey: 'k1' }), '<body></body>')
    expect(out).toContain('"storageKey":"k1"')
    expect(out).not.toContain('preset')
    expect(out).not.toContain('hotkey')
  })
  it('defaults inject empty config', () => {
    const out = transform(overlay(), '<body></body>')
    expect(out).toContain('init({})')
  })
})
