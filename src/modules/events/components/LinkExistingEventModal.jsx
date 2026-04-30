/**
 * LinkExistingEventModal — pick one of the session user's already-
 * published kind 31922 / 31923 events to link the current draft to.
 * Linking sets the draft's `dTag` to the chosen event's dTag, so
 * publishing the draft replaces that event on Nostr (replaceable per
 * (kind, pubkey, dTag)).
 *
 * Mirrors LinkExistingListingModal in the marketplace — same shape, two
 * entry points (pick from list, paste naddr). Linking is identity-only:
 * we don't load the event's content into the draft (that's what the
 * composer's "Load" action at the top does).
 */
import { useEffect, useMemo, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { Z } from '../../../lib/zIndex.js'
import { getNDK, connectAndWait } from '../../../lib/ndk.js'
import { withTimeout } from '../../../lib/utils.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  parseCalendarEvent,
  formatEventTime,
} from '../../../lib/eventTypes.js'

export default function LinkExistingEventModal({ sessionUser, currentDTag = '', onSelect, onClose }) {
  const sessionPubkey = sessionUser?.pubkey || null
  const [events, setEvents]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const [naddrInput, setNaddrInput] = useState('')
  const [naddrError, setNaddrError] = useState('')

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!sessionPubkey) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        const set = await withTimeout(
          ndk.fetchEvents({
            kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT],
            authors: [sessionPubkey],
            limit: 200,
          }),
          8000,
          'fetch-timeout',
        )
        if (cancelled) return
        // Latest revision wins per (kind, pubkey, dTag).
        const byCoord = new Map()
        for (const ev of set || []) {
          const d = ev.tags?.find(t => t[0] === 'd')?.[1]
          if (!d) continue
          const key = `${ev.kind}:${ev.pubkey}:${d}`
          const prev = byCoord.get(key)
          if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) byCoord.set(key, ev)
        }
        const parsed = []
        for (const ev of byCoord.values()) {
          const p = parseCalendarEvent({
            id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
            tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
          })
          if (p) parsed.push(p)
        }
        // Future first (start asc), then past (most-recent-past first).
        const now = Math.floor(Date.now() / 1000)
        parsed.sort((a, b) => {
          const aFut = (a.endUnix ?? a.startUnix) >= now
          const bFut = (b.endUnix ?? b.startUnix) >= now
          if (aFut && !bFut) return -1
          if (!aFut && bFut) return  1
          if (aFut) return a.startUnix - b.startUnix
          return b.startUnix - a.startUnix
        })
        setEvents(parsed)
      } catch (err) {
        if (!cancelled) {
          setError(err?.message === 'fetch-timeout' ? 'Relays timed out.' : (err?.message || 'Load failed.'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [sessionPubkey])

  const sortedEvents = useMemo(() => events, [events])

  function handleNaddrSubmit(e) {
    e.preventDefault()
    setNaddrError('')
    const input = naddrInput.trim()
    if (!input) return
    try {
      const decoded = nip19.decode(input)
      if (decoded.type === 'naddr') {
        if (decoded.data.kind !== KIND_DATE_EVENT && decoded.data.kind !== KIND_TIME_EVENT) {
          setNaddrError(`Not a kind 31922/31923 event (got kind ${decoded.data.kind}).`)
          return
        }
        if (decoded.data.pubkey !== sessionPubkey) {
          setNaddrError('That naddr belongs to a different author. You can only replace your own events.')
          return
        }
        onSelect({ dTag: decoded.data.identifier, title: '' })
        return
      }
      setNaddrError('Paste a kind 31922/31923 naddr1… string.')
    } catch {
      setNaddrError('Could not decode that as an naddr.')
    }
  }

  return (
    <div
      className={`fixed inset-0 ${Z.modal} bg-black/60 flex items-center justify-center p-4`}
      onMouseDown={onClose}
    >
      <div
        className={`bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden ${Z.modalContent}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-neutral-200">Replace existing event</h2>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              Choose a published event whose Nostr identity this draft should adopt. Publishing will replace that event.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 transition-colors text-xl leading-none p-1.5 -m-1.5"
            aria-label="Close"
          >✕</button>
        </div>

        {/* naddr paste — escape hatch */}
        <form
          onSubmit={handleNaddrSubmit}
          className="flex items-center gap-2 px-4 py-3 border-b border-neutral-800 flex-shrink-0"
        >
          <input
            type="text"
            value={naddrInput}
            onChange={(e) => { setNaddrInput(e.target.value); if (naddrError) setNaddrError('') }}
            placeholder="Paste an naddr1…"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
          />
          <button
            type="submit"
            disabled={!naddrInput.trim()}
            className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            Link
          </button>
        </form>
        {naddrError && (
          <p className="text-xs text-red-400 px-4 pt-2">{naddrError}</p>
        )}

        {/* List of user's events */}
        <div className="flex-1 overflow-auto">
          {!sessionPubkey && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">
              Sign in to see your events.
            </p>
          )}
          {sessionPubkey && loading && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">Loading your events…</p>
          )}
          {sessionPubkey && error && (
            <p className="text-xs text-red-400 px-4 py-6">{error}</p>
          )}
          {sessionPubkey && !loading && !error && sortedEvents.length === 0 && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">
              No published events found. Use the naddr field above for an event on a private relay, or cancel and publish this draft as a new event.
            </p>
          )}
          {sessionPubkey && !loading && !error && sortedEvents.length > 0 && (
            <ul className="divide-y divide-neutral-800">
              {sortedEvents.map(p => (
                <EventRow
                  key={`${p.kind}:${p.pubkey}:${p.dTag}`}
                  parsed={p}
                  isCurrent={!!currentDTag && p.dTag === currentDTag}
                  onPick={() => onSelect({ dTag: p.dTag, title: p.title || '' })}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-neutral-800 flex justify-end">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function EventRow({ parsed, isCurrent, onPick }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={`w-full flex items-start gap-3 px-4 py-2.5 transition-colors text-left ${
          isCurrent ? 'bg-blue-950/25 hover:bg-blue-950/40' : 'hover:bg-neutral-800/60'
        }`}
      >
        <div className="flex-shrink-0 w-10 h-10 rounded bg-neutral-800 border border-neutral-700 overflow-hidden flex items-center justify-center text-neutral-600">
          <span className="text-sm" aria-hidden>📅</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-xs text-neutral-200 truncate flex-1 min-w-0">
              {parsed.title || 'Untitled event'}
            </p>
            {isCurrent && (
              <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-200 border border-blue-800 flex-shrink-0">
                Currently linked
              </span>
            )}
          </div>
          <p className="text-[10px] text-neutral-500 mt-0.5 truncate">
            {formatEventTime(parsed)}
          </p>
          <p className="text-[10px] text-neutral-600 mt-0.5 font-mono truncate">
            d:{parsed.dTag}
          </p>
        </div>
      </button>
    </li>
  )
}
