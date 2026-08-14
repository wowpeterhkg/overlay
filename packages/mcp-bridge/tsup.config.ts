import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
})
