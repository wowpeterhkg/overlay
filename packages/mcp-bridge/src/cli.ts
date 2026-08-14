import { BridgeStore } from './store'
import { startServer } from './server'
import { startMcp } from './mcp'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { exec } from 'node:child_process'

const args = process.argv.slice(2)
function argOf(name: string, dflt: string) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }

const dir = argOf('--dir', path.join(homedir(), '.overlay'))
const port = Number(argOf('--port', '8787'))
const testHttp = args.includes('--test-http')

const store = new BridgeStore(dir)

const tokenFile = path.join(dir, 'token')
const firstRun = !existsSync(tokenFile)
const token = firstRun ? randomBytes(16).toString('hex') : readFileSync(tokenFile, 'utf8').trim()
if (firstRun) writeFileSync(tokenFile, token)

const server = startServer({ port, token, store, testHttp })

// Port collision: fail loudly, name the port and the flag (spec §8).
process.on('uncaughtException', (e: any) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`overlay-mcp: port ${port} is already in use. Pass --port <other> (and re-pair).`)
    process.exit(1)
  }
  throw e
})

if (firstRun && !testHttp) {
  const url = `http://localhost:${port}/pair`
  console.error(`overlay-mcp: first run — opening ${url} to pair the extension`)
  const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(opener)
}

startMcp(store, server)
console.error(`overlay-mcp: WS on ws://localhost:${port} · store at ${dir}`)
