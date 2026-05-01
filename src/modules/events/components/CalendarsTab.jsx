/**
 * CalendarsTab — owner sees their own kind 31924 calendar lists; visitors
 * see the page-owner's public calendars.
 *
 * Sorting: calendars with at least one upcoming event go first, ordered
 * by soonest upcoming. A "Past" section break follows, with past-only
 * calendars sorted by most-recently-occurred event first. To know which
 * bucket each calendar belongs in we eager-fetch every event coord
 * across every calendar in one batch (one fetch per kind), parse, and
 * group by calendar.
 *
 * Card layout matches the CalendarDetailView header (80px hero +
 * title/summary/count) so the at-a-glance and the deep-link views feel
 * like the same surface.
 *
 * Click a card's chevron to expand inline — the events list directly
 * below uses the same EventCard component as the Discover feed (date
 * pill + title + summary + location + thumbnail + ⋯ menu) so the inline
 * view feels visually continuous with Discover. Container is scrollable
 * (max-h ≈ 6-7 cards). Three-dot menu on each calendar holds owner-only
 * Edit / Delete and a "View full page" deep-link.
 *
 * Empty state for owners includes a "+ New calendar" affordance backed
 * by the same CollectionEditModal used for editing.
 */
import { useEffect, useMemo, useState, useCallback, useRef, Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { isSafeUrl } from '../../../lib/utils.js'
import { useEventCalendars } from '../../../lib/useEventCalendars.js'
import { useEventRsvpSummaries } from '../../../lib/useEventRsvpSummaries.js'
import { fetchEventsForRefs, groupByCalendar } from '../../../lib/calendarEvents.js'
import { isFutureEvent } from '../../../lib/eventTypes.js'
import EventCard from './EventCard.jsx'
import CollectionEditModal from '../../marketplace/components/collections/CollectionEditModal.jsx'

export default function CalendarsTab({ viewedUser, sessionUser, isOwner }) {
  const navigate = useNavigate()
  const {
    calendars, loading, error, pending,
    createCalendar, updateMetadata, deleteCalendar,
  } = useEventCalendars(viewedUser?.pubkey || null)

  const npub = viewedUser?.npub

  // Eager-fetch every event referenced across every calendar so we can
  // (a) sort calendars by soonest upcoming, (b) render the inline events
  // list when a card is expanded without an extra round-trip.
  const [eventsByCoord, setEventsByCoord] = useState(() => new Map())
  const [eventsLoading, setEventsLoading] = useState(false)
  const refsKey = useMemo(() => {
    const all = new Set()
    for (const { decoded } of calendars) {
      for (const ref of decoded.eventRefs || []) all.add(ref)
    }
    return [...all].sort().join('|')
  }, [calendars])

  useEffect(() => {
    if (!refsKey) { setEventsByCoord(new Map()); return }
    let cancelled = false
    setEventsLoading(true)
    ;(async () => {
      const refs = refsKey.split('|').filter(Boolean)
      const { eventsByCoord: m } = await fetchEventsForRefs(refs)
      if (!cancelled) {
        setEventsByCoord(m)
        setEventsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [refsKey])

  // Group events per calendar (sorted future-first inside each group).
  const eventsByCalendar = useMemo(
    () => groupByCalendar(calendars, eventsByCoord),
    [calendars, eventsByCoord],
  )

  // Sort calendars: upcoming bucket first (asc by soonest event),
  // then past bucket (desc by most-recent event). A calendar with no
  // events at all sinks to the bottom of the past bucket.
  const sorted = useMemo(() => {
    const now = Math.floor(Date.now() / 1000)
    const enriched = calendars.map(({ decoded }) => {
      const events = eventsByCalendar.get(decoded.dTag) || []
      let nextUpcoming = Infinity
      let lastPast = -Infinity
      for (const p of events) {
        if (isFutureEvent(p, now)) {
          if (p.startUnix < nextUpcoming) nextUpcoming = p.startUnix
        } else {
          if (p.startUnix > lastPast) lastPast = p.startUnix
        }
      }
      const isUpcoming = nextUpcoming < Infinity
      return { decoded, events, nextUpcoming, lastPast, isUpcoming }
    })
    enriched.sort((a, b) => {
      if (a.isUpcoming !== b.isUpcoming) return a.isUpcoming ? -1 : 1
      if (a.isUpcoming) return a.nextUpcoming - b.nextUpcoming
      return b.lastPast - a.lastPast
    })
    return enriched
  }, [calendars, eventsByCalendar])

  // Where the upcoming → past boundary is, for the section divider.
  // -1 → all upcoming; 0 → all past; n>0 → divider sits before index n.
  const firstPastIndex = useMemo(
    () => sorted.findIndex(c => !c.isUpcoming),
    [sorted],
  )

  // RSVP summary lookups for every event across every calendar — one hook
  // call across the union so EventCards in the expanded view get full
  // RSVP avatar stacks just like Discover does.
  const allEvents = useMemo(() => [...eventsByCoord.values()], [eventsByCoord])
  const { summaryFor } = useEventRsvpSummaries(allEvents)

  // Optimistic delete handler shared across every expanded EventCard.
  // Drops the deleted event from local state so the row disappears
  // without waiting for a refetch.
  const handleEventDeleted = useCallback((deleted) => {
    setEventsByCoord(prev => {
      const next = new Map(prev)
      const key = `${deleted.kind}:${deleted.pubkey}:${deleted.dTag}`
      next.delete(key)
      return next
    })
  }, [])

  const [expandedDTag, setExpandedDTag] = useState(null)
  const [actionMenuDTag, setActionMenuDTag] = useState(null)
  const [editTarget, setEditTarget] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [confirmDeleteDTag, setConfirmDeleteDTag] = useState(null)
  const [deleteError, setDeleteError] = useState('')

  function toggleExpand(dTag) {
    setExpandedDTag(prev => prev === dTag ? null : dTag)
  }

  function openInFullPage(dTag) {
    if (!npub || !dTag) return
    navigate(`/${npub}/events/cal-${encodeURIComponent(dTag)}`)
  }

  async function handleCreateSave({ title, summary, image }) {
    const r = await createCalendar({ title, summary, image })
    if (r?.ok) setCreateOpen(false)
    return r
  }

  async function handleEditSave({ title, summary, image }) {
    if (!editTarget) return { ok: false }
    const r = await updateMetadata(editTarget.dTag, { title, summary, image })
    if (r?.ok) setEditTarget(null)
    return r
  }

  async function handleDelete(dTag) {
    setDeleteError('')
    const r = await deleteCalendar(dTag)
    if (!r?.ok) {
      setDeleteError(r?.error || 'Delete failed.')
      return
    }
    setConfirmDeleteDTag(null)
    if (expandedDTag === dTag) setExpandedDTag(null)
  }

  if (!viewedUser?.pubkey) return null

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-4 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-md bg-neutral-900 animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <div className="text-3xl mb-2">⚠️</div>
        <div className="text-sm text-neutral-300">Couldn't load calendars</div>
        <div className="text-[11px] text-neutral-500 mt-1">{error}</div>
      </div>
    )
  }

  if (calendars.length === 0) {
    return (
      <>
        <div className="max-w-2xl mx-auto px-4 py-12 text-center">
          <div className="text-3xl mb-2">🗓</div>
          <div className="text-sm text-neutral-300">
            {isOwner ? 'No calendars yet' : 'No calendars to show'}
          </div>
          <div className="text-[11px] text-neutral-500 mt-1 max-w-xs mx-auto">
            {isOwner
              ? 'Create one to organize your events, or save to a calendar from the ⋯ menu on any event.'
              : 'This user hasn\'t organized any events into calendars yet.'}
          </div>
          {isOwner && (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="text-xs px-3 py-1.5 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors"
              >
                + New calendar
              </button>
            </div>
          )}
        </div>
        {createOpen && (
          <CollectionEditModal
            mode="create"
            headerLabel="New calendar"
            onSave={handleCreateSave}
            onClose={() => setCreateOpen(false)}
          />
        )}
      </>
    )
  }

  return (
    <div className="w-full">
    <div className="max-w-2xl mx-auto px-4 py-4">
      {isOwner && (
        <div className="flex justify-end mb-3">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors"
          >
            + New calendar
          </button>
        </div>
      )}

      {sorted.map((entry, i) => {
        const showPastDivider = firstPastIndex >= 0 && i === firstPastIndex
        return (
          <Fragment key={entry.decoded.dTag}>
            {showPastDivider && (
              <div className="flex items-center gap-3 py-2 px-1 text-[10px] uppercase tracking-wide text-neutral-500">
                <span className="flex-1 h-px bg-neutral-800" aria-hidden />
                <span>Past</span>
                <span className="flex-1 h-px bg-neutral-800" aria-hidden />
              </div>
            )}
            <CalendarSection
              entry={entry}
              isOwner={isOwner}
              sessionUser={sessionUser}
              isExpanded={expandedDTag === entry.decoded.dTag}
              actionMenuOpen={actionMenuDTag === entry.decoded.dTag}
              confirmingDelete={confirmDeleteDTag === entry.decoded.dTag}
              deleteError={confirmDeleteDTag === entry.decoded.dTag ? deleteError : ''}
              pending={pending}
              eventsLoading={eventsLoading}
              summaryFor={summaryFor}
              onEventDeleted={handleEventDeleted}
              onToggleExpand={() => toggleExpand(entry.decoded.dTag)}
              onToggleActions={() => setActionMenuDTag(prev =>
                prev === entry.decoded.dTag ? null : entry.decoded.dTag
              )}
              onEdit={() => { setEditTarget(entry.decoded); setActionMenuDTag(null) }}
              onOpenFull={() => { openInFullPage(entry.decoded.dTag); setActionMenuDTag(null) }}
              onAskDelete={() => { setConfirmDeleteDTag(entry.decoded.dTag); setDeleteError(''); setActionMenuDTag(null) }}
              onConfirmDelete={() => handleDelete(entry.decoded.dTag)}
              onCancelDelete={() => { setConfirmDeleteDTag(null); setDeleteError('') }}
            />
          </Fragment>
        )
      })}

      {createOpen && (
        <CollectionEditModal
          mode="create"
          headerLabel="New calendar"
          onSave={handleCreateSave}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {editTarget && (
        <CollectionEditModal
          mode="edit"
          headerLabel="Edit calendar"
          initialTitle={editTarget.title || ''}
          initialSummary={editTarget.summary || ''}
          initialImage={editTarget.image || ''}
          onSave={handleEditSave}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
    </div>
  )
}

/**
 * One calendar — header row plus an optional inline events list rendered
 * full-width with the standard EventCard. No outer border/rounded on the
 * section itself; the events expand flush with the page wrapper so the
 * list visually matches the Discover feed exactly.
 */
function CalendarSection({
  entry, isOwner, sessionUser, isExpanded, actionMenuOpen,
  confirmingDelete, deleteError, pending, eventsLoading,
  summaryFor, onEventDeleted,
  onToggleExpand, onToggleActions,
  onEdit, onOpenFull, onAskDelete, onConfirmDelete, onCancelDelete,
}) {
  const { decoded, events, nextUpcoming, lastPast, isUpcoming } = entry
  const refsCount = (decoded.eventRefs || []).length

  const subtitle = (() => {
    if (isUpcoming) return `Next: ${formatDate(nextUpcoming)}`
    if (Number.isFinite(lastPast)) return `Last: ${formatDate(lastPast)}`
    if (refsCount > 0 && eventsLoading) return 'Loading…'
    if (refsCount > 0) return 'No events loaded'
    return 'No events yet'
  })()

  const actionRef = useRef(null)
  useEffect(() => {
    if (!actionMenuOpen) return
    function onPointer(e) {
      if (actionRef.current?.contains(e.target)) return
      onToggleActions()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [actionMenuOpen, onToggleActions])

  return (
    <>
      {/* Header — single flex div, structurally identical to EventCard
          (px-3, py-3, border-b, hover bg) so it spans full max-w-2xl
          width like Discover's events. The 80px hero + larger title
          still reads as distinct from event rows. */}
      <div className="w-full grid grid-cols-[80px_1fr_auto] gap-3 items-stretch px-3 py-3 border-b border-neutral-800/60 hover:bg-neutral-900/40 transition-colors group">
        <Hero image={decoded.image} />
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 min-w-0 text-left"
          aria-expanded={isExpanded}
        >
          <div className="text-sm text-neutral-100 font-medium truncate">{decoded.title}</div>
          {decoded.summary && (
            <div className="text-[11px] text-neutral-400 truncate mt-0.5">{decoded.summary}</div>
          )}
          <div className="text-[10px] text-neutral-500 mt-1">
            {refsCount} event{refsCount === 1 ? '' : 's'} · {subtitle}
          </div>
        </button>
        <div className="flex items-start gap-0.5 shrink-0">
          {isOwner && (
            <div className="relative" ref={actionRef}>
              <button
                type="button"
                onClick={onToggleActions}
                aria-label="Actions"
                title="Actions"
                className="p-1.5 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <circle cx="3" cy="8" r="1.4" />
                  <circle cx="8" cy="8" r="1.4" />
                  <circle cx="13" cy="8" r="1.4" />
                </svg>
              </button>
              {actionMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 rounded-md border border-neutral-700 bg-neutral-900 shadow-lg z-10 overflow-hidden">
                  <button onClick={onEdit} className="w-full text-left px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 transition-colors">
                    Edit details
                  </button>
                  <button onClick={onOpenFull} className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors">
                    Open full page →
                  </button>
                  <button onClick={onAskDelete} className="w-full text-left px-3 py-2 text-xs text-rose-300 hover:bg-rose-950/40 transition-colors border-t border-neutral-800">
                    Delete calendar
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            title={isExpanded ? 'Collapse' : 'Expand to see events'}
            className="p-1.5 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
              className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} aria-hidden>
              <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {confirmingDelete && (
        <div className="mt-1 border border-rose-900/50 bg-rose-950/20 rounded-md px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-rose-200">
            Delete this calendar? Events stay; only the list itself is removed.
          </span>
          {deleteError && <span className="text-[10px] text-red-400">{deleteError}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={pending}
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={pending}
              className="text-[11px] px-2 py-1 rounded border border-rose-700 bg-rose-950/40 text-rose-200 hover:bg-rose-900/60 disabled:opacity-50"
            >
              {pending ? 'Deleting…' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {/* Inline events list — full-width EventCards exactly like Discover.
          Scrollable when the list overflows ~6-7 cards (max-h-[28rem]). */}
      {isExpanded && (
        eventsLoading && events.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-neutral-500 border-b border-neutral-800/60">Loading events…</div>
        ) : events.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-neutral-500 border-b border-neutral-800/60">
            {refsCount > 0
              ? 'None of this calendar\'s events could be loaded right now.'
              : 'No events in this calendar yet.'}
          </div>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto border-b border-neutral-800/60">
            {events.map(p => (
              <EventCard
                key={p.naddr || p.id}
                parsed={p}
                summary={summaryFor(p)}
                sessionUser={sessionUser}
                onDeleted={onEventDeleted}
              />
            ))}
          </div>
        )
      )}
    </>
  )
}

function Hero({ image }) {
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

function formatDate(unix) {
  if (!Number.isFinite(unix)) return ''
  const d = new Date(unix * 1000)
  const now = Date.now()
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}
