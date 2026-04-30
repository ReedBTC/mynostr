/**
 * MyCreated — the viewed user's published calendar events (31922/31923).
 * Rendered for both owner and visitor — anyone can see the events
 * a user has published. Sort: future events first (start ascending),
 * past events after, most-recent-past first.
 */
import { useEffect, useMemo, useState } from 'react'
import { getNDK, connectAndWait } from '../../../lib/ndk.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  parseCalendarEvent,
} from '../../../lib/eventTypes.js'
import { useEventRsvpSummaries } from '../../../lib/useEventRsvpSummaries.js'
import EventCard from './EventCard.jsx'

export default function MyCreated({ viewedUser, sessionUser }) {
  const pubkey = viewedUser?.pubkey
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  // After a successful kind-5 from the menu, drop the row optimistically
  // so the user sees their action took. The relay-side tombstone races
  // behind; if a refresh happens before propagation, the next fetch
  // honours the kind-5 by id.
  const handleDeleted = (deleted) => {
    setEvents(prev => prev.filter(p =>
      !(p.kind === deleted.kind && p.pubkey === deleted.pubkey && p.dTag === deleted.dTag)
    ))
  }

  useEffect(() => {
    if (!pubkey) { setEvents([]); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setEvents([])
    const ndk = getNDK()
    ;(async () => {
      try {
        await connectAndWait(ndk, 3000)
        const set = await ndk.fetchEvents({
          kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT],
          authors: [pubkey],
          limit: 200,
        })
        if (cancelled) return
        // Same `(pubkey, kind, d)` may yield multiple revisions across
        // relays — keep the latest per coordinate.
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
        setEvents(parsed)
      } catch {
        if (!cancelled) setEvents([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  const { upcoming, past } = useMemo(() => splitFuturePast(events), [events])
  const { summaryFor } = useEventRsvpSummaries(events)

  if (!pubkey) return null
  if (loading) return <Skeleton />
  if (events.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="text-3xl mb-2">📅</div>
        <div className="text-sm text-neutral-300">No events yet</div>
        <div className="text-[11px] text-neutral-500 mt-1">
          Nothing published from this account.
        </div>
      </div>
    )
  }

  // Same horizontal extent as the New Event composer (max-w-2xl + px-4)
  // so the two tabs visually line up when toggled.
  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      {upcoming.length > 0 && (
        <Section label={`Upcoming (${upcoming.length})`}>
          {upcoming.map(p => (
            <EventCard
              key={p.naddr || p.id}
              parsed={p}
              summary={summaryFor(p)}
              sessionUser={sessionUser}
              onDeleted={handleDeleted}
            />
          ))}
        </Section>
      )}
      {past.length > 0 && (
        <Section label={`Past (${past.length})`}>
          {past.map(p => (
            <EventCard
              key={p.naddr || p.id}
              parsed={p}
              summary={summaryFor(p)}
              sessionUser={sessionUser}
              onDeleted={handleDeleted}
            />
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({ label, children }) {
  return (
    <div>
      <div className="px-3 sm:px-4 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-950/40 border-b border-neutral-900">
        {label}
      </div>
      {children}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="p-3 space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-16 rounded bg-neutral-900 animate-pulse" />
      ))}
    </div>
  )
}

function splitFuturePast(events) {
  const now = Math.floor(Date.now() / 1000)
  const upcoming = [], past = []
  for (const p of events) {
    const cutoff = p.endUnix ?? p.startUnix
    if (cutoff >= now) upcoming.push(p)
    else past.push(p)
  }
  upcoming.sort((a, b) => a.startUnix - b.startUnix)
  past.sort((a, b) => b.startUnix - a.startUnix) // most recent past first
  return { upcoming, past }
}
