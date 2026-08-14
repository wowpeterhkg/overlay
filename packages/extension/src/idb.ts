const DB = 'ovl-shots', STORE = 'shots'

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}
export async function putShot(id: string, value: { blob: Blob; cropped: boolean; createdAt: number }) {
  const db = await open()
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, id)
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error)
  })
}
export async function getShot(id: string): Promise<{ blob: Blob; cropped: boolean } | undefined> {
  const db = await open()
  return new Promise((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id)
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error)
  })
}
export async function deleteShot(id: string) {
  const db = await open()
  await new Promise<void>((res) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => res()
  })
}
