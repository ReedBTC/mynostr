/**
 * MyRsvps — events the viewed user RSVP'd to (kind 31925), grouped
 * by status. Rendering steps:
 *   1. Fetch all 31925 by viewedUser.pubkey
 *   2. Latest-wins dedup per (author, target) — handles clients that
 *      use UUID d-tags as well as our reuse-target-as-d scheme
 *   3. Resolve each unique target coordinate to a calendar event
 *   4. Render Going / Maybe / Not-going sections
 */
import { useEffect, useMemo, useState } from 'react'
import { getNDK, connectAndWait } from '../../../lib/ndk.js'
import {
  KIND_RSVP,
  parseRsvp,
  parseCalendarEvent,
  dedupRsvpsLatest,
} from '../../../lib/eventTypes.js'
import { useEventRsvpSummaries } from '../../../lib/useEventRsvpSummaries.js'
import EventCard from './EventCard.jsx'

const STATUS_ORDER = [
  { id: 'accepted',  label: 'Going' },
  { id: 'tentative', label: 'Maybe' },
  { id: 'declined',  label: 'Not going' },
]

export default function MyRsvps({ viewedUser, sessionUser }) {
  const pubkey = viewedUser?.pubkey
  const [rsvpsByStatus, setRsvpsByStatus] = useState({ accepted: [], tentative: [], declined: [] })
  const [loading, setLoading] = useState(true)

  // Optimistic drop after a kind-5 from the menu. RSVPs is unusual:
  // the user might delete an event they don't own (rare on this tab,
  // since it's RSVPs not authored events). The menu only exposes
  // Delete to the owner, so this branch only fires when the deleted
  // event is one this user authored *and* RSVP'd to themselves.
  const handleDeleted = (deleted) => {
    setRsvpsByStatus(prev => {
      const next = { accepted: [], tentative: [], declined: [] }
      for (const [status, list] of Object.entries(prev)) {
        next[status] = list.filter(({ parsed }) =>
          !(parsed.kind === deleted.kind && parsed.pubkey === deleted.pubkey && parsed.dTag === deleted.dTag)
        )
      }
      return next
    })
  }

  useEffect(() => {
    if (!pubkey) { setLoading(false); setRsvpsByStatus({ accepted: [], tentative: [], declined: [] }); return }
    let cancelled = false
    setLoading(true)
    setRsvpsByStatus({ accepted: [], tentative: [], declined: [] })
    const ndk = getNDK()
    ;(async () => {
      try {
        await connectAndWait(ndk, 3000)
        const rsvpSet = await ndk.fetchEvents({
          kinds: [KIND_RSVP],
          authors: [pubkey],
          limit: 500,
        })
        if (cancelled) return
        const parsed = []
        for (const ev of rsvpSet || []) {
          const r = parseRsvp({
            id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
            tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
          })
          if (r) parsed.push(r)
        }
        const deduped = dedupRsvpsLatest(parsed)

        // Resolve each unique targetCoord. Group filters by kind to
        // shape NDK fetches, with author + d arrays.
        const wantByKind = new Map()
        for (const r of deduped) {
          const m = /^(\d+):([0-9a-f]{64}):(.+)$/i.exec(r.targetCoord)
          if (!m) continue
          const kind = +m[1], author = m[2], d = m[3]
          const k = wantByKind.get(kind) || { authors: new Set(), ds: new Set() }
          k.authors.add(author); k.ds.add(d)
          wantByKind.set(kind, k)
        }
        // Single batched fetch per kind. Some relays don't index #d
        // efficiently; this still works because we filter post-fetch.
        const eventsByCoord = new Map()
        for (const [kind, { authors, ds }] of wantByKind) {
          if (authors.size === 0) continue
          try {
            const set = await ndk.fetchEvents({
              kinds: [kind],
              authors: [...authors],
              '#d': [...ds],
              limit: 500,
            })
            for (const ev of set || []) {
              const dTag = ev.tags?.find(t => t[0] === 'd')?.[1]
              if (!dTag) continue
              const key = `${ev.kind}:${ev.pubkey}:${dTag}`
              const prev = eventsByCoord.get(key)
              if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) {
                eventsByCoord.set(key, ev)
              }
            }
          } catch {}
        }
        if (cancelled) return

        const grouped = { accepted: [], tentative: [], declined: [] }
        for (const r of deduped) {
          const ev = eventsByCoord.get(r.targetCoord)
          if (!ev) continue
          const p = parseCalendarEvent({
            id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
            tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
          })
          if (p) grouped[r.status].push({ rsvpAt: r.createdAt, parsed: p })
        }
        // Sort each bucket: future first by start ascending, then past
        // by recency (most recent past first).
        for (const k of Object.keys(grouped)) grouped[k].sort(byUpcomingThenRecentPast)
        setRsvpsByStatus(grouped)
      } catch {
        if (!cancelled) setRsvpsByStatus({ accepted: [], tentative: [], declined: [] })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  const totals = useMemo(() => ({
    accepted:  rsvpsByStatus.accepted.length,
    tentative: rsvpsByStatus.tentative.length,
    declined:  rsvpsByStatus.declined.length,
  }), [rsvpsByStatus])

  // Flat list of every parsed event across the three buckets — fed
  // into the summary hook so each card can show its own RSVP stack.
  const allEvents = useMemo(() => {
    const out = []
    for (const bucket of Object.values(rsvpsByStatus)) {
      for (const { parsed } of bucket) out.push(parsed)
    }
    return out
  }, [rsvpsByStatus])
  const { summaryFor } = useEventRsvpSummaries(allEvents)

  if (!pubkey) return null
  if (loading) return <Skeleton />
  const empty = totals.accepted + totals.tentative + totals.declined === 0
  if (empty) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="text-3xl mb-2">🎟️</div>
        <div className="text-sm text-neutral-300">No RSVPs yet</div>
        <div className="text-[11px] text-neutral-500 mt-1">
          Events this user RSVP's to will land here.
        </div>
      </div>
    )
  }

  // Same horizontal extent as the New Event composer / My Events feed.
  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      {STATUS_ORDER.map(s => {
        const list = rsvpsByStatus[s.id]
        if (!list || list.length === 0) return null
        return (
          <div key={s.id}>
            <div className="px-3 sm:px-4 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-950/40 border-b border-neutral-900">
              {s.label} ({list.length})
            </div>
            {list.map(({ parsed }) => (
              <EventCard
                key={parsed.naddr || parsed.id}
                parsed={parsed}
                summary={summaryFor(parsed)}
                sessionUser={sessionUser}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="p-3 space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-16 rounded bg-neutral-900 animate-pulse" />
      ))}
    </div>
  )
}

function byUpcomingThenRecentPast(a, b) {
  const now = Math.floor(Date.now() / 1000)
  const aFuture = (a.parsed.endUnix ?? a.parsed.startUnix) >= now
  const bFuture = (b.parsed.endUnix ?? b.parsed.startUnix) >= now
  if (aFuture !== bFuture) return aFuture ? -1 : 1
  if (aFuture) return a.parsed.startUnix - b.parsed.startUnix
  return b.parsed.startUnix - a.parsed.startUnix
}
