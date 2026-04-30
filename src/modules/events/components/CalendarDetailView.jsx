/**
 * CalendarDetailView — single calendar page. Shows the calendar's
 * metadata (title, summary, cover image) and the events it contains
 * as a feed of EventCards.
 *
 * Reachable at /<viewer_npub>/events/calendar/<dTag>. The npub in the
 * URL is the *page-owner's* (whose calendar this is); the viewer of
 * the page may be a different account or anonymous. Owner sees an
 * Edit / Delete row at the top; visitors see read-only.
 *
 * Event refs (kind 31922/31923 coordinates) are batch-fetched in one
 * relay round-trip, latest-wins-deduped per coord, then sorted future-
 * first then past most-recent-first (mirrors MyCreated's split).
 */
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { getNDK, connectAndWait } from '../../../lib/ndk.js'
import { withTimeout, isSafeUrl } from '../../../lib/utils.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  parseCalendarEvent,
  isFutureEvent,
} from '../../../lib/eventTypes.js'
import { useEventCalendars } from '../../../lib/useEventCalendars.js'
import { useEventRsvpSummaries } from '../../../lib/useEventRsvpSummaries.js'
import EventCard from './EventCard.jsx'
// Reuse marketplace's edit modal verbatim — it's a generic
// title/summary/image editor with Blossom upload, exactly the shape
// a calendar list needs. Cross-module import is fine here; if events
// ever needs calendar-specific fields (visibility, default-view), we
// can fork at that point.
import CollectionEditModal from '../../marketplace/components/collections/CollectionEditModal.jsx'

export default function CalendarDetailView({ dTag, viewedUser, sessionUser, isOwner }) {
  const navigate = useNavigate()
  const location = useLocation()
  const pubkey = viewedUser?.pubkey
  const npub = viewedUser?.npub

  const {
    calendars, loading: calendarsLoading,
    removeFromCalendar, updateMetadata, deleteCalendar, pending,
  } = useEventCalendars(pubkey)

  const [editOpen, setEditOpen] = useState(false)

  const calendar = useMemo(() => {
    return calendars.find(c => c.decoded.dTag === dTag)?.decoded || null
  }, [calendars, dTag])

  // Fetch the calendar's referenced events. Latest-wins per coord; we
  // take the eventRefs as authoritative — relay query is best-effort.
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const eventRefsKey = useMemo(
    () => (calendar?.eventRefs || []).slice().sort().join('|'),
    [calendar],
  )

  useEffect(() => {
    if (!calendar) { setEvents([]); return }
    const refs = calendar.eventRefs || []
    if (refs.length === 0) { setEvents([]); return }
    let cancelled = false
    setEventsLoading(true)
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        // Group refs by kind, batch-fetch each group with #d arrays.
        const byKind = new Map()
        for (const ref of refs) {
          const m = /^(\d+):([0-9a-f]{64}):(.+)$/i.exec(ref)
          if (!m) continue
          const kind = parseInt(m[1], 10)
          const author = m[2], dT = m[3]
          const k = byKind.get(kind) || { authors: new Set(), ds: new Set() }
          k.authors.add(author); k.ds.add(dT)
          byKind.set(kind, k)
        }
        const eventsByCoord = new Map()
        for (const [kind, { authors, ds }] of byKind) {
          if (kind !== KIND_DATE_EVENT && kind !== KIND_TIME_EVENT) continue
          if (authors.size === 0 || ds.size === 0) continue
          try {
            const set = await withTimeout(
              ndk.fetchEvents({
                kinds: [kind],
                authors: [...authors],
                '#d': [...ds],
                limit: 500,
              }),
              8000,
              'fetch-timeout',
            )
            for (const ev of set || []) {
              const dT = ev.tags?.find(t => t[0] === 'd')?.[1]
              if (!dT) continue
              const key = `${ev.kind}:${ev.pubkey}:${dT}`
              const prev = eventsByCoord.get(key)
              if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) eventsByCoord.set(key, ev)
            }
          } catch {}
        }
        if (cancelled) return
        const parsed = []
        for (const ref of refs) {
          const ev = eventsByCoord.get(ref)
          if (!ev) continue
          const p = parseCalendarEvent({
            id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
            tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
          })
          if (p) parsed.push(p)
        }
        // Future-first ascending, past most-recent first.
        const now = Math.floor(Date.now() / 1000)
        parsed.sort((a, b) => {
          const aFut = isFutureEvent(a, now)
          const bFut = isFutureEvent(b, now)
          if (aFut && !bFut) return -1
          if (!aFut && bFut) return  1
          if (aFut) return a.startUnix - b.startUnix
          return b.startUnix - a.startUnix
        })
        setEvents(parsed)
      } catch {
        if (!cancelled) setEvents([])
      } finally {
        if (!cancelled) setEventsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [eventRefsKey, calendar])

  const { summaryFor } = useEventRsvpSummaries(events)

  // Same back-button logic as EventDetail. Deep-link fallback drops
  // back to the calendars tab on this page-owner's events.
  const handleBack = useCallback(() => {
    if (location.key && location.key !== 'default') { navigate(-1); return }
    if (npub) navigate(`/${npub}/events/calendars`)
    else navigate('/')
  }, [location.key, navigate, npub])

  // Optimistically drop a row when the user removes an event from the
  // calendar via its three-dot menu (the menu doesn't know we want
  // this — we handle it via the `onDeleted` mechanic. Removal is a
  // separate action, surfaced as a button on the row).
  const handleEventDeleted = (deleted) => {
    setEvents(prev => prev.filter(p =>
      !(p.kind === deleted.kind && p.pubkey === deleted.pubkey && p.dTag === deleted.dTag)
    ))
  }

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  async function handleDeleteCalendar() {
    if (!isOwner) return
    setDeleteError('')
    const r = await deleteCalendar(dTag)
    if (!r?.ok) {
      setDeleteError(r?.error || 'Delete failed.')
      return
    }
    if (npub) navigate(`/${npub}/events/calendars`)
    else navigate('/')
  }

  async function handleRemoveFromCalendar(parsed) {
    if (!isOwner || !parsed) return
    const coord = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
    const r = await removeFromCalendar(dTag, coord)
    if (r?.ok) handleEventDeleted(parsed)
  }

  if (calendarsLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-4">
        <BackChip onClick={handleBack} />
        <div className="space-y-2 mt-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-neutral-900 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (!calendar) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-4">
        <BackChip onClick={handleBack} />
        <div className="px-4 py-12 text-center">
          <div className="text-3xl mb-2">🤷</div>
          <div className="text-sm text-neutral-300">Calendar not found</div>
          <div className="text-[11px] text-neutral-500 mt-1">
            The relays we tried don't have a calendar with this id.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <BackChip onClick={handleBack} />
        {isOwner && (
          confirmDelete ? (
            <div className="inline-flex items-center gap-1.5">
              {deleteError && <span className="text-[10px] text-red-400 mr-1">{deleteError}</span>}
              <span className="text-[11px] text-neutral-400">Delete this calendar?</span>
              <button
                type="button"
                onClick={() => { setConfirmDelete(false); setDeleteError('') }}
                disabled={pending}
                className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteCalendar}
                disabled={pending}
                className="text-xs px-2 py-1 rounded border border-red-700 bg-red-950/40 text-red-200 hover:bg-red-900/60 disabled:opacity-50"
              >
                {pending ? 'Deleting…' : 'Confirm'}
              </button>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-xs px-2.5 py-1 rounded border border-rose-900/70 text-rose-300 hover:bg-rose-950/40 focus:outline-none focus:ring-1 focus:ring-rose-700"
              >
                Delete
              </button>
            </div>
          )
        )}
      </div>

      {editOpen && (
        <CollectionEditModal
          mode="edit"
          headerLabel="Edit calendar"
          initialTitle={calendar.title || ''}
          initialSummary={calendar.summary || ''}
          initialImage={calendar.image || ''}
          onSave={async ({ title, summary, image }) => {
            return await updateMetadata(dTag, { title, summary, image })
          }}
          onClose={() => setEditOpen(false)}
        />
      )}

      <div className="flex items-stretch gap-3 mb-4">
        <CalendarHero image={calendar.image} />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-neutral-100 leading-tight">{calendar.title}</h1>
          {calendar.summary && (
            <p className="text-xs text-neutral-400 mt-1">{calendar.summary}</p>
          )}
          <p className="text-[10px] text-neutral-500 mt-1">
            {events.length} event{events.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {eventsLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-neutral-900 animate-pulse" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="px-4 py-12 text-center text-xs text-neutral-500">
          {(calendar.eventRefs || []).length > 0
            ? 'None of this calendar\'s events could be loaded — relays may be down or the events have been deleted.'
            : 'No events in this calendar yet. Save events to it from the ⋯ menu on any event.'}
        </div>
      ) : (
        events.map(p => (
          <div key={p.naddr || p.id} className="relative">
            <EventCard
              parsed={p}
              summary={summaryFor(p)}
              sessionUser={sessionUser}
              onDeleted={handleEventDeleted}
            />
            {isOwner && (
              <button
                type="button"
                onClick={() => handleRemoveFromCalendar(p)}
                disabled={pending}
                title="Remove from this calendar"
                className="absolute right-2 bottom-2 text-[10px] px-1.5 py-0.5 rounded border border-neutral-800 text-neutral-500 hover:text-rose-300 hover:border-rose-900/70 transition-colors disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function BackChip({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M6.5 2 L3 5 L6.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Back
    </button>
  )
}

function CalendarHero({ image }) {
  if (image && isSafeUrl(image)) {
    return (
      <img
        src={image}
        alt=""
        className="w-20 h-20 rounded bg-neutral-800 border border-neutral-700 object-cover flex-shrink-0"
        onError={(e) => { e.currentTarget.style.display = 'none' }}
      />
    )
  }
  return (
    <div className="w-20 h-20 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-500 flex-shrink-0">
      <span className="text-2xl" aria-hidden>🗓</span>
    </div>
  )
}
