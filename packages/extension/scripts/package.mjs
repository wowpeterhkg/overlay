import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
const out = 'dist-ext'
mkdirSync(out, { recursive: true })
for (const f of ['content.js', 'probe.js', 'sw.js', 'popup.js']) cpSync(`dist/${f}`, `${out}/${f}`)
cpSync('manifest.json', `${out}/manifest.json`)
cpSync('popup.html', `${out}/popup.html`)
// placeholder icon: 1x1 png is rejected by chrome; ship a 128x128 solid square
if (!existsSync(`${out}/icon128.png`)) {
  const ICON_B64 = readFileSync(new URL('./icon128.b64', import.meta.url), 'utf8')
  writeFileSync(`${out}/icon128.png`, Buffer.from(ICON_B64, 'base64'))
}
