import { defineConfig } from 'tsup'
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.esm.js' : '.cjs.js' }),
    noExternal: ['@idnerd/overlay-core'],
    sourcemap: true,
    dts: true,
    platform: 'browser',
    target: 'es2019',
  },
  {
    entry: { vite: 'src/vite.ts' },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.esm.js' : '.cjs.js' }),
    external: ['vite'],
    sourcemap: true,
    dts: { tsconfig: 'tsconfig.vite.json' },
    platform: 'node',
    target: 'node18',
  },
])
