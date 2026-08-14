/* Persistence adapters. An adapter is {load(): tags|Promise, save(tags): void|Promise}.
   Serialization lives here; the store deals only in arrays. */
export function localStorageAdapter(storageKey) {
  return {
    load: function () {
      try { return JSON.parse(localStorage.getItem(storageKey) || '[]') } catch (e) { return [] }
    },
    save: function (tags) { localStorage.setItem(storageKey, JSON.stringify(tags)) },
  }
}

/* Bridge to any async string KV (chrome.storage.local, disk, …).
   get(): Promise<string|null>, set(json: string): Promise<void>. */
export function asyncAdapter(kv) {
  return {
    load: function () {
      return Promise.resolve(kv.get()).then(function (raw) {
        try { return JSON.parse(raw || '[]') } catch (e) { return [] }
      })
    },
    save: function (tags) { return Promise.resolve(kv.set(JSON.stringify(tags))) },
  }
}
