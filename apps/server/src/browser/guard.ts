/**
 * Runs in every page while an agent fills a form: blocks the final submit (click or form submit),
 * whatever triggers it. "Next"/"Continue" steps of multi-page forms still work. Also sends the
 * page's own saves one at a time, so autosaving forms (Ashby) don't drop fields the agent filled.
 * Turned off (window.__sidedoorFilling = false) once the agent is done, so the user can submit.
 */
export const GUARD = `(() => {
  if (window.__sidedoorGuard) return
  window.__sidedoorGuard = true
  if (window.__sidedoorFilling === undefined) window.__sidedoorFilling = true
  const FINAL = /\\bsubmit\\b|send application|complete application/i
  const label = (el) => (el && (el.innerText || el.value || el.getAttribute('aria-label') || '')).trim()
  const finalButton = (t) => {
    const b = t && t.closest && t.closest('button, input[type=submit], input[type=button], [role=button], a')
    return b && FINAL.test(label(b)) ? b : null
  }
  const block = (e, what) => {
    if (!window.__sidedoorFilling) return
    e.preventDefault(); e.stopImmediatePropagation()
    console.warn('[sidedoor] blocked ' + what + ' while filling; you submit')
  }
  document.addEventListener('click', (e) => { if (finalButton(e.target)) block(e, 'submit click') }, true)
  document.addEventListener('submit', (e) => {
    const s = e.submitter
    if (!s || FINAL.test(label(s))) block(e, 'form submit')
  }, true)
  // Ashby (and other autosaving forms) save each field as it changes, and the server merges each
  // save into its copy of the form. Claude fills fields milliseconds apart, so saves overlap and the
  // server drops some: the field still looks filled, but submit fails with "Missing entry".
  // Send the page's own non-GET requests one at a time while filling, as a person typing would.
  const fetch0 = window.fetch.bind(window)
  let tail = Promise.resolve()
  window.fetch = (input, init) => {
    const req = input instanceof Request ? input : null
    const method = ((init && init.method) || (req && req.method) || 'GET').toUpperCase()
    const url = new URL(req ? req.url : String(input), location.href)
    if (!window.__sidedoorFilling || method === 'GET' || url.origin !== location.origin) return fetch0(input, init)
    const run = tail.then(() => fetch0(input, init))
    // A hung request holds the queue for at most 10s.
    tail = Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, 10000))])
    return run
  }
})()`

export const BANNER = `(() => {
  window.__sidedoorFilling = false
  if (document.getElementById('sidedoor-banner')) return
  const d = document.createElement('div')
  d.id = 'sidedoor-banner'
  d.textContent = 'Sidedoor filled this form. Review every field, then submit it yourself.'
  d.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);background:#e8b931;color:#111;font:600 14px system-ui;padding:8px 14px;border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.35);cursor:pointer'
  d.title = 'Click to dismiss'
  d.onclick = () => d.remove()
  document.body.appendChild(d)
})()`

