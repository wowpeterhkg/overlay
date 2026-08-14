import { defineConfig } from 'tsup'
export default defineConfig([
  { // content script + popup: classic scripts, core bundled in
    entry: { content: 'src/content.ts', popup: 'src/popup.ts', probe: 'src/probe.js' },
    format: ['iife'],
    outDir: 'dist',
    noExternal: ['@idnerd/overlay-core'],
    platform: 'browser',
    target: 'es2020',
    outExtension: () => ({ js: '.js' }),
  },
  { // module service worker
    entry: { sw: 'src/sw.ts' },
    format: ['esm'],
    outDir: 'dist',
    platform: 'browser',
    target: 'es2020',
    outExtension: () => ({ js: '.js' }),
  },
])
