// Lateral-scroll deck shell.
//
// The wheel handling is the non-obvious part. A handler that only asks "can any
// ancestor still scroll in this direction?" pages the deck the moment an inner
// scroller bottoms out — and the trackpad inertia from that same gesture is what
// fires it. Reaching the end of a table flips the slide, which reads as a design
// choice rather than a bug.
//
// So there are two checks. `canScroll` lets the inner element keep the gesture
// while it still has room. `inScroller` plus a time latch handles the edge: if
// the pointer sits inside a scrollable subtree at all and the previous wheel
// event was under REARM_MS ago, the event is swallowed instead of paging.
// Inertia keeps the latch warm; after a real pause the next scroll pages.
(() => {
  const deck = document.querySelector('.deck')
  if (!deck) return
  const pages = [...deck.querySelectorAll('.page')]
  const dots = [...document.querySelectorAll('.dot')]
  const counter = document.querySelector('.counter')

  // Tracked explicitly: reading scrollLeft mid-smooth-scroll collapses rapid key presses.
  let idx = 0
  const paint = () => {
    dots.forEach((d, j) => d.setAttribute('aria-current', String(j === idx)))
    if (counter) counter.textContent = `${idx + 1} / ${pages.length}`
  }
  const go = (i) => {
    idx = Math.max(0, Math.min(pages.length - 1, i))
    pages[idx].scrollIntoView({ block: 'nearest', inline: 'start' })
    paint()
  }

  /** Nearest scrollable ancestor that still has room to move in direction dy. */
  const canScroll = (el, dy) => {
    while (el && el !== deck) {
      if (el.scrollHeight > el.clientHeight + 4) {
        const atTop = el.scrollTop <= 0
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
        if (!((atTop && dy < 0) || (atBottom && dy > 0))) return true
      }
      el = el.parentElement
    }
    return false
  }

  /** Any scrollable ancestor at all, at its edge or not. */
  const inScroller = (el) => {
    while (el && el !== deck) {
      if (el.scrollHeight > el.clientHeight + 4) return true
      el = el.parentElement
    }
    return false
  }

  const REARM_MS = 350
  const PAGE_DELTA = 40
  const LOCK_MS = 480

  let acc = 0
  let lock = false
  let lastWheel = 0

  deck.addEventListener('wheel', (ev) => {
    const now = performance.now()
    const gap = now - lastWheel
    lastWheel = now
    if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return
    // Consumed internally: reset the accumulator, or the deltas add up and the
    // page turns by itself seconds later.
    if (canScroll(ev.target, ev.deltaY)) { acc = 0; return }
    ev.preventDefault()
    if (inScroller(ev.target) && gap < REARM_MS) { acc = 0; return }
    if (lock) return
    acc += ev.deltaY
    // scroll-snap-type: x mandatory snaps small scrollLeft nudges straight back,
    // so the deck has to advance a whole page at a time.
    if (Math.abs(acc) < PAGE_DELTA) return
    const dir = acc > 0 ? 1 : -1
    acc = 0
    if ((dir > 0 && idx >= pages.length - 1) || (dir < 0 && idx <= 0)) return
    lock = true
    go(idx + dir)
    setTimeout(() => { lock = false; acc = 0 }, LOCK_MS)
  }, { passive: false })

  addEventListener('keydown', (ev) => {
    const map = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }
    if (ev.key in map) { ev.preventDefault(); go(idx + map[ev.key]) }
    if (ev.key === 'Home') { ev.preventDefault(); go(0) }
    if (ev.key === 'End') { ev.preventDefault(); go(pages.length - 1) }
  })
  dots.forEach((d, i) => d.addEventListener('click', () => go(i)))

  let settle
  deck.addEventListener('scroll', () => {
    clearTimeout(settle)
    settle = setTimeout(() => {
      idx = Math.round(deck.scrollLeft / window.innerWidth)
      paint()
    }, 120)
  }, { passive: true })

  paint()
})()
