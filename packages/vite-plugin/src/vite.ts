import type { Plugin } from 'vite'

export interface OverlayOptions {
  /** Fix-prompt text prepended to the clipboard export. Default: built-in generic prompt. */
  preset?: string
  /** localStorage key. Default: 'overlay_tags' */
  storageKey?: string
  /** Arm shortcut. Default: 'Alt+A' */
  hotkey?: string
}

function clientConfig(options: OverlayOptions): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  if (options.preset !== undefined) cfg.preset = options.preset
  if (options.storageKey !== undefined) cfg.storageKey = options.storageKey
  if (options.hotkey !== undefined) cfg.hotkey = options.hotkey
  return cfg
}

/**
 * Dev-only UI feedback overlay. `apply:'serve'` keeps the plugin out of
 * `vite build` entirely; the injected script re-guards on import.meta.env.DEV.
 * Pattern from joshcirre/instruckt (MIT).
 */
export default function overlay(options: OverlayOptions = {}): Plugin {
  return {
    name: 'idnerd-overlay',
    apply: 'serve',
    transformIndexHtml: {
      // 'pre' so Vite's own dev HTML pipeline still processes the injected
      // inline script (proxies it + rewrites the bare '@idnerd/overlay' import).
      order: 'pre',
      handler(html: string) {
        const cfg = JSON.stringify(clientConfig(options))
        const script = `<script type="module">
import { init } from '@idnerd/overlay';
if (import.meta.env.DEV) init(${cfg});
</script>`
        return html.replace('</body>', `${script}\n</body>`)
      },
    },
  }
}
