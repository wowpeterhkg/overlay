/* Runs in the page's MAIN world — the only place __reactFiber$* expandos are
   visible. Finds the nearest user-land composite component name above an
   element. Marker-attribute handshake: content script (isolated world) sets
   data-ovl-probe="<seq>" on the target (attributes are shared via the DOM),
   posts a window message, and we look the element back up by attribute. */
(function () {
  function fiberOf(el) {
    for (var k in el) if (k.indexOf('__reactFiber$') === 0) return el[k]
    return null
  }
  function nameOf(type) {
    if (!type) return null
    if (typeof type === 'string') return null            // host tag (div etc.)
    return type.displayName || type.name || null
  }
  function componentFor(el) {
    var node = el
    while (node && !fiberOf(node)) node = node.parentElement
    var f = node && fiberOf(node)
    var hops = 0
    while (f && hops < 50) {
      var n = nameOf(f.type)
      // skip host fibers, fragments, providers, and 1–2 char minified junk
      if (n && n.length > 2 && n !== 'Fragment' && !/Provider$|^Context/.test(n)) return n
      f = f.return
      hops++
    }
    return null
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || !e.data.__ovlProbe) return
    var seq = e.data.__ovlProbe.seq
    var el = document.querySelector('[data-ovl-probe="' + seq + '"]')
    var component = null
    try { component = el ? componentFor(el) : null } catch (err) { /* degrade silently */ }
    window.postMessage({ __ovlProbeResult: { seq: seq, component: component } }, '*')
  })
})()
