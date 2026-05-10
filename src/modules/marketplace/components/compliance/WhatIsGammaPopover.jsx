/**
 * WhatIsGammaPopover — small inline `(?)` affordance that explains
 * what Gamma is and links to the spec. Used in the compliance banner
 * and panel header so the seller has a one-click learn-more without
 * us cluttering the chrome with explainer text.
 *
 * Click toggles. Esc + click-outside dismiss. The trigger is a quiet
 * `(?)` button — not loud — because Gamma is optional and we don't
 * want to imply the seller has to know about it.
 */
import { useEffect, useRef, useState } from 'react'

export default function WhatIsGammaPopover() {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapperRef.current?.contains(e.target)) return
      setOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={wrapperRef} className="relative inline-block align-baseline">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label="What is Gamma?"
        aria-expanded={open}
        title="What is Gamma?"
        className="text-[11px] text-neutral-500 hover:text-neutral-300 underline-offset-2 hover:underline transition-colors"
      >
        (?)
      </button>
      {open && (
        <span
          role="dialog"
          className="absolute left-0 top-full mt-1 w-64 z-40 bg-neutral-900 border border-neutral-700 rounded shadow-xl p-3 text-left"
          onMouseDown={e => e.stopPropagation()}
        >
          <span className="block text-[11px] text-neutral-300 leading-relaxed">
            <span className="font-medium text-neutral-100">Gamma</span> is an
            optional extension to NIP-99 that lets marketplace apps support
            automated checkout — price quoting, payment routing, shipping
            calculation. Classified-style listings work fine without it.
          </span>
          <span className="block mt-2 space-y-1">
            <a
              href="https://github.com/GammaMarkets/market-spec"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[11px] text-purple-300 hover:text-purple-100 transition-colors"
            >
              Read the Gamma spec ↗
            </a>
            <a
              href="https://plebeian.market"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[11px] text-purple-300 hover:text-purple-100 transition-colors"
            >
              Plebeian Market (a Gamma checkout app) ↗
            </a>
          </span>
        </span>
      )}
    </span>
  )
}
