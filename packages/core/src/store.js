/* Tag store — owns persistence + mutation through an adapter. UI never
   touches storage. createStore returns synchronously with an empty list;
   `ready` resolves once the initial load lands (sync adapters resolve on
   the microtask, so the Vite-plugin path is unaffected in practice). */
export function createStore(adapter) {
  let tags = []
  let lastSave = Promise.resolve()
  /* true once any mutation has been queued — guards the initial load from
     clobbering a mutation that arrived before it resolved. */
  let dirty = false

  /* adapter.load() may throw synchronously or reject; either way this never
     rejects — a broken adapter degrades to an empty list, not a crash. */
  function safeLoad() {
    var result
    try { result = adapter.load() } catch (err) { result = Promise.reject(err) }
    return Promise.resolve(result).catch(function (err) {
      console.warn('[overlay] load failed', err)
      return []
    })
  }

  const ready = safeLoad().then(function (loaded) {
    if (dirty) return // a pre-ready mutation already queued a save; keep it
    tags = Array.isArray(loaded) ? loaded : []
  })

  function save() {
    dirty = true
    /* chain onto lastSave so concurrent saves serialize instead of racing;
       the .catch(()=>{}) keeps a failed save from breaking the chain. */
    lastSave = lastSave.catch(function () {}).then(function () {
      var snapshot = tags.slice()
      return Promise.resolve(adapter.save(snapshot)).catch(function (err) {
        console.warn('[overlay] save failed', err)
      })
    })
  }
  function find(id) { return tags.filter(function (t) { return t.id === id })[0] }

  return {
    ready: ready,
    /* awaitable "last write hit the adapter" — for tests and sync mirrors */
    flushed: function () { return lastSave },
    reload: function () {
      // Unlike the initial `ready` load, reload() always applies its result —
      // callers use it when external storage is the source of truth.
      return safeLoad().then(function (loaded) {
        tags = Array.isArray(loaded) ? loaded : []
      })
    },
    replaceAll: function (next) { tags = next.slice(); save() },
    list: function () { return tags },
    openTags: function () { return tags.filter(function (t) { return t.status !== 'resolved' }) },
    add: function (t) { tags.push(t); save() },
    update: function (id, patch) {
      var t = find(id); if (!t) return
      Object.keys(patch).forEach(function (k) { t[k] = patch[k] })
      save()
    },
    removeById: function (id) { tags = tags.filter(function (t) { return t.id !== id }); save() },
    resolveById: function (id) { var t = find(id); if (t) { t.status = 'resolved'; save() } },
    clear: function () { tags = []; save() },
  }
}
