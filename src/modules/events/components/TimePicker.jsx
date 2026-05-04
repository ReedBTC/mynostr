/**
 * TimePicker — slot-list time picker styled to match the rest of the
 * dark theme. Replaces the OS-native `<input type="time">` because the
 * native control:
 *   • shows tiny hours/minutes spinners on desktop (poor affordance),
 *   • on iOS hijacks the keyboard with a wheel that's awkward to scrub
 *     across a wide range,
 *   • can't be styled.
 *
 * The pattern below is the one Lu.ma / Partiful / Google Calendar use:
 * a button showing the current time; click opens a dropdown of
 * 15-minute slots in 12-hour format the user can scroll and tap.
 *
 * `value` and `onChange` use the same "HH:MM" 24-hour string the native
 * input emits, so this is a drop-in replacement.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

const SLOT_MINUTES = 15

export default function TimePicker({
  value,
  onChange,
  disabled = false,
  className = '',
  // Optional per-slot disable predicate. When supplied, slots for which
  // it returns true render greyed-out and unclickable. Used by the notes
  // scheduler to dim past-time slots when the picked date is today.
  isSlotDisabled,
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)

  // Close on click-outside / Escape.
  useEffect(() => {
    if (!open) return
    function handleDown(e) {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target)) setOpen(false)
    }
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('touchstart', handleDown, { passive: true })
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('touchstart', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  // Scroll the active slot into view when the dropdown opens.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      const list = listRef.current
      if (!list) return
      const sel = list.querySelector('[data-active="true"]')
      if (sel && typeof sel.scrollIntoView === 'function') {
        sel.scrollIntoView({ block: 'center' })
      }
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  const slots = useMemo(() => buildSlots(SLOT_MINUTES), [])
  const display = formatDisplay(value)

  return (
    <div ref={wrapRef} className={'relative ' + className}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={
          'w-full text-left bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-100 hover:border-neutral-500 focus:outline-none focus:border-purple-600 disabled:opacity-50 ' +
          (open ? 'border-purple-600' : '')
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="inline-flex items-center justify-between w-full gap-2">
          <span>{display || 'Pick a time'}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-neutral-500" aria-hidden>
            <path d="M2 4 L5 7 L8 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-30 mt-1 w-full max-h-60 overflow-y-auto bg-neutral-900 border border-neutral-700 rounded-md shadow-xl py-1 text-sm"
          // Touch listening on the parent should not blur the popover; we
          // explicitly stop propagation so the click-outside listener
          // doesn't immediately close it.
          onMouseDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
        >
          {slots.map(slot => {
            const active   = slot.value === value
            const slotOff  = !!isSlotDisabled?.(slot.value)
            return (
              <button
                key={slot.value}
                type="button"
                role="option"
                aria-selected={active}
                aria-disabled={slotOff || undefined}
                disabled={slotOff}
                data-active={active ? 'true' : undefined}
                onClick={() => {
                  if (slotOff) return
                  onChange(slot.value)
                  setOpen(false)
                }}
                className={
                  'w-full text-left px-3 py-2 transition-colors ' +
                  (slotOff
                    ? 'text-neutral-600 cursor-not-allowed'
                    : active
                      ? 'bg-purple-600/30 text-purple-100'
                      : 'text-neutral-200 hover:bg-neutral-800')
                }
              >
                {slot.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function buildSlots(stepMinutes) {
  const out = []
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += stepMinutes) {
      out.push({
        value: `${pad2(h)}:${pad2(m)}`,
        label: format12h(h, m),
      })
    }
  }
  return out
}

function pad2(n) { return String(n).padStart(2, '0') }

function format12h(h, m) {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${pad2(m)} ${ampm}`
}

function formatDisplay(hhmm) {
  if (!hhmm) return ''
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return hhmm
  return format12h(+m[1], +m[2])
}
