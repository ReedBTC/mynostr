import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '../../lib/zIndex.js'

/**
 * InfoDot — small (i) icon that toggles a popover with a short disclaimer.
 *
 * Used on the profile stat cards to explain where their numbers come from
 * (Primal cache, NIP-51 lists, …) and that indexer lag means very recent
 * activity may not be reflected yet. Closes on outside click or Escape.
 *
 * The popover renders through a portal to `document.body` with fixed
 * positioning so it can:
 *   - escape any `overflow: hidden` card boundary (previously the note
 *     got clipped at the bottom of shorter cards like DmRelayCard rows)
 *   - layer above the RelayDiscoveryModal stack (overlay z-50 / content
 *     z-51 / mobile close z-52 / nested confirm z-60) so it's readable
 *     when opened from inside a search-another-user's-relays modal
 *
 * `align` controls which edge of the popover is anchored to the trigger:
 *   right (default) — popover extends leftward; good when the trigger
 *                     sits near the right edge of its container
 *   left            — popover extends rightward
 */
export default function InfoDot({ children, align = 'right', className = '' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState(null)
  const triggerRef      = useRef(null)

  // Compute popover position from the trigger's bounding rect when opened.
  // Dismiss on scroll/resize rather than trying to chase the trigger —
  // matches how NoteActionBar's portaled dropdown handles it.
  useEffect(() => {
    if (!open || !triggerRef.current) { setPos(null); return }
    const rect = triggerRef.current.getBoundingClientRect()
    if (align === 'right') {
      setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right })
    } else {
      setPos({ top: rect.bottom + 6, left: rect.left })
    }
    function dismiss() { setOpen(false) }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, align])

  // Outside-click + Escape. The popover is portaled outside the trigger's
  // DOM subtree, so we also accept clicks inside the portaled element via
  // a data-attribute check; otherwise any click inside the popover would
  // register as "outside" and immediately dismiss it.
  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (triggerRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-info-dot-popover="true"]')) return
      setOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        aria-label="About this data"
        aria-expanded={open}
        className={`${open ? 'text-purple-300' : 'text-neutral-600 hover:text-neutral-300'} transition-colors p-0.5 -m-0.5`}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7v4" strokeLinecap="round" />
          <circle cx="8" cy="5" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          role="dialog"
          data-info-dot-popover="true"
          className={`fixed w-64 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl ${Z.infoPopover} p-3 text-[11px] leading-snug text-neutral-300 normal-case tracking-normal font-normal`}
          style={pos}
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}
