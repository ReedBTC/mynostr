/**
 * LocationAutocomplete — text input with a Nominatim-backed dropdown.
 *
 * The Location field on a Nostr calendar event is free-form per spec
 * (NIP-52 just says a string), but most consumers want a real address
 * so a map link or geohash makes sense. We use OpenStreetMap's
 * Nominatim service via lib/nominatim.js — no API key, free, with
 * built-in rate limiting and an LRU cache.
 *
 * Behaviors:
 *   • Typing 2+ chars triggers a debounced (300ms) search.
 *   • Picking a result fills the location string with the canonical
 *     display name, and bubbles up lat/lon via onPickPlace so the
 *     parent can encode the geohash (NIP-52 'g' tag).
 *   • Free-form typing without picking a suggestion is fully supported
 *     — the input is the source of truth.
 */
import { useEffect, useRef, useState } from 'react'
import { searchPlaces, encodeGeohash } from '../../../lib/nominatim.js'

export default function LocationAutocomplete({
  value,
  onChange,
  // Called when a result is picked. ({ displayName, lat, lon, geohash })
  onPickPlace,
  placeholder = 'Address, venue, or a meeting URL',
  className = '',
}) {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const wrapRef = useRef(null)
  const abortRef = useRef(null)

  // Debounced search — fires 300ms after the last keystroke; aborts
  // any in-flight request before kicking off the next one so a fast
  // typist doesn't race three responses to the dropdown.
  useEffect(() => {
    const q = String(value || '').trim()
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    const id = setTimeout(async () => {
      try {
        const list = await searchPlaces(q, { signal: ac.signal, limit: 6 })
        if (ac.signal.aborted) return
        setResults(list || [])
      } catch {
        if (!ac.signal.aborted) setResults([])
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => { clearTimeout(id); ac.abort() }
  }, [value])

  // Click-outside / Escape close.
  useEffect(() => {
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
  }, [])

  function pick(r) {
    const displayName = r?.displayName || ''
    if (!displayName) return
    onChange(displayName)
    if (onPickPlace) {
      const geohash = (Number.isFinite(r.lat) && Number.isFinite(r.lon))
        ? encodeGeohash(r.lat, r.lon, 9)
        : ''
      onPickPlace({ displayName, lat: r.lat, lon: r.lon, geohash })
    }
    setOpen(false)
    setActive(-1)
  }

  function handleKey(e) {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(a => (a + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(a => (a - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      if (active >= 0 && active < results.length) {
        e.preventDefault()
        pick(results[active])
      }
    }
  }

  const showDropdown =
    open && (loading || results.length > 0) && String(value || '').trim().length >= 2

  return (
    <div ref={wrapRef} className={'relative ' + className}>
      <input
        type="search"
        value={value || ''}
        onChange={e => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
          // The user is typing freely — once they diverge from a picked
          // suggestion, drop the cached geohash so we don't ship a
          // 'g' tag that doesn't match the new location text.
          if (onPickPlace) onPickPlace({ displayName: e.target.value, lat: NaN, lon: NaN, geohash: '' })
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
        className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-purple-600"
      />
      {showDropdown && (
        <div
          className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto bg-neutral-900 border border-neutral-700 rounded-md shadow-xl py-1 text-sm"
          onMouseDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
        >
          {loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">No matches</div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.displayName}-${i}`}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(r)}
              className={
                'w-full text-left px-3 py-2 transition-colors ' +
                (i === active
                  ? 'bg-purple-600/30 text-purple-100'
                  : 'text-neutral-200 hover:bg-neutral-800')
              }
            >
              <div className="text-sm leading-snug">{r.displayName}</div>
              {r.type && (
                <div className="text-[10px] text-neutral-500 mt-0.5">
                  {r.type}
                </div>
              )}
            </button>
          ))}
          <div className="px-3 py-1.5 text-[10px] text-neutral-600 border-t border-neutral-800 mt-1">
            Powered by OpenStreetMap Nominatim
          </div>
        </div>
      )}
    </div>
  )
}
