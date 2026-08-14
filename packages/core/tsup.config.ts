import { defineConfig } from 'tsup'
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  outDir: 'dist',
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.esm.js' : '.cjs.js' }),
  sourcemap: true,
  dts: true,
  platform: 'browser',
  target: 'es2019',
})
