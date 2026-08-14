const OFF_GLOBAL = 'ovl_off_global'
const OFF_ORIGINS = 'ovl_off_origins'

const conn = document.getElementById('conn')!
const count = document.getElementById('count')!
const siteBox = document.getElementById('site') as HTMLInputElement
const globalBox = document.getElementById('global') as HTMLInputElement
const hint = document.getElementById('hint')!

async function currentOrigin(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url || !/^https?:/.test(tab.url)) return null
  return new URL(tab.url).origin
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ kind: 'ovl-status' }).catch(() => null)
  conn.textContent = s?.connected ? 'connected' : 'off'
  count.textContent = s ? String(s.tagCount) : '–'

  const v = await chrome.storage.local.get([OFF_GLOBAL, OFF_ORIGINS])
  globalBox.checked = !v[OFF_GLOBAL]

  const origin = await currentOrigin()
  if (!origin) {
    siteBox.checked = false
    siteBox.disabled = true
    hint.textContent = 'This page type is not supported.'
    return
  }
  const offOrigins: string[] = v[OFF_ORIGINS] ?? []
  siteBox.disabled = !!v[OFF_GLOBAL]
  siteBox.checked = !v[OFF_GLOBAL] && !offOrigins.includes(origin)
  hint.textContent = v[OFF_GLOBAL] ? 'Master switch is off.' : origin
}

siteBox.addEventListener('change', async () => {
  const origin = await currentOrigin()
  if (!origin) return
  const v = await chrome.storage.local.get(OFF_ORIGINS)
  const offOrigins = new Set<string>(v[OFF_ORIGINS] ?? [])
  if (siteBox.checked) offOrigins.delete(origin)
  else offOrigins.add(origin)
  await chrome.storage.local.set({ [OFF_ORIGINS]: [...offOrigins] })
  refresh()
})

globalBox.addEventListener('change', async () => {
  await chrome.storage.local.set({ [OFF_GLOBAL]: !globalBox.checked })
  refresh()
})

refresh()
