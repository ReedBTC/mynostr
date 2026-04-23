import { useEffect, useRef, useState } from 'react'

/**
 * InfoDot — small (i) icon that toggles a popover with a short disclaimer.
 *
 * Used on the profile stat cards to explain where their numbers come from
 * (Primal cache, NIP-51 lists, …) and that indexer lag means very recent
 * activity may not be reflected yet. Closes on outside click or Escape.
 */
export default function InfoDot({ children, align = 'right', className = '' }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const alignClass = align === 'left' ? 'left-0' : 'right-0'

  return (
    <span ref={rootRef} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
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
      {open && (
        <div
          role="dialog"
          className={`absolute top-full ${alignClass} mt-1.5 w-64 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl z-40 p-3 text-[11px] leading-snug text-neutral-300 normal-case tracking-normal font-normal`}
        >
          {children}
        </div>
      )}
    </span>
  )
}
