/**
 * useEventRsvpSummaries — bulk-fetch RSVPs for a list of parsed
 * calendar events and return a per-event summary used by the avatar
 * stack on EventCard.
 *
 * One relay round-trip for RSVPs (kind 31925, `#a` array of coords)
 * across the entire feed. One Primal round-trip for profiles of the
 * up-to-3-most-recent accepted RSVPers per event. The summary map is
 * keyed by event coord so a single hook serves every card whether
 * it's in MyCreated, MyRsvps, or EventsDiscover.
 *
 * Why a hook rather than per-card fetches:
 *   • A 50-event feed → 50 separate RSVP queries (relay-thrash) plus
 *     up to 150 profile queries. The bulk path collapses both to one
 *     round-trip apiece.
 *   • Cards re-render on filter changes / scroll / hover; per-card
 *     hooks would refetch on every churn. The hook here keys its
 *     effect on a stable string of coords so toggling Time-window
 *     pills doesn't trigger refetches.
 */
import { useEffect, useMemo, useState } from 'react'
import { getNDK, connectAndWait } from './ndk.js'
import { fetchProfiles } from './primal.js'
import {
  KIND_RSVP,
  parseRsvp,
  dedupRsvpsLatest,
  coordOf,
} from './eventTypes.js'

const AVATARS_PER_EVENT = 3

/**
 * @param {Array} events  — parsed calendar events from parseCalendarEvent
 * @returns {{
 *   summaryFor: (parsed: object) => Summary | null,
 *   loading: boolean,
 * }}
 *
 * Summary shape:
 *   {
 *     goingCount, maybeCount, decliningCount,
 *     acceptedTop: [{ pubkey, profile }],   // up to AVATARS_PER_EVENT
 *   }
 *
 * Returns the same `summaryFor` reference across renders until the
 * underlying data actually changes — avoids triggering child memos
 * keyed on prop identity.
 */
export function useEventRsvpSummaries(events) {
  const coords = useMemo(() => {
    const set = new Set()
    for (const p of events || []) {
      const c = coordOf(p)
      if (c) set.add(c)
    }
    return [...set]
  }, [events])

  // Stable key so effects don't refire when the list reorders. Cap at
  // 200 to keep the relay filter under most relays' max-args limit; if
  // the feed is bigger than that the tail just doesn't get summaries
  // (better than the whole query failing).
  const coordKey = useMemo(
    () => coords.slice(0, 200).sort().join('|'),
    [coords],
  )

  // rsvpsByCoord: coord -> dedup'd RSVP records (latest-wins per author)
  const [rsvpsByCoord, setRsvpsByCoord] = useState(() => new Map())
  const [profileMap,   setProfileMap]   = useState(() => new Map())
  const [loading,      setLoading]      = useState(false)

  useEffect(() => {
    if (!coordKey) {
      setRsvpsByCoord(new Map())
      setLoading(false)
      return
    }
    let cancelled = false
    const targetCoords = coordKey.split('|').filter(Boolean)
    if (targetCoords.length === 0) return
    setLoading(true)
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        const set = await ndk.fetchEvents({
          kinds: [KIND_RSVP],
          '#a': targetCoords,
          limit: 1000,
        })
        if (cancelled) return
        const parsed = []
        for (const ev of set || []) {
          const r = parseRsvp({
            id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
            tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
          })
          if (r) parsed.push(r)
        }
        const deduped = dedupRsvpsLatest(parsed)
        const grouped = new Map()
        for (const r of deduped) {
          if (!targetCoords.includes(r.targetCoord)) continue
          const list = grouped.get(r.targetCoord) || []
          list.push(r)
          grouped.set(r.targetCoord, list)
        }
        // Sort each list newest-rsvp-first so the avatar stack shows
        // the most recently confirmed attendees — feels alive.
        for (const list of grouped.values()) {
          list.sort((a, b) => b.createdAt - a.createdAt)
        }
        setRsvpsByCoord(grouped)
      } catch {
        if (!cancelled) setRsvpsByCoord(new Map())
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [coordKey])

  // Once RSVPs land, batch-fetch profiles for the union of accepted
  // RSVPers across every event (capped to AVATARS_PER_EVENT per event,
  // so a 50-event feed pulls at most 150 profiles in one Primal call).
  const acceptedPubkeysKey = useMemo(() => {
    const seen = new Set()
    for (const list of rsvpsByCoord.values()) {
      let count = 0
      for (const r of list) {
        if (count >= AVATARS_PER_EVENT) break
        if (r.status !== 'accepted') continue
        seen.add(r.pubkey)
        count++
      }
    }
    return [...seen].sort().join('|')
  }, [rsvpsByCoord])

  useEffect(() => {
    if (!acceptedPubkeysKey) return
    const pubkeys = acceptedPubkeysKey.split('|').filter(Boolean)
    if (pubkeys.length === 0) return
    let cancelled = false
    fetchProfiles(pubkeys).then(fetched => {
      if (cancelled) return
      setProfileMap(prev => {
        const next = new Map(prev)
        for (const [k, v] of fetched) next.set(k, v)
        return next
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [acceptedPubkeysKey])

  // Stable summaryFor — same reference until rsvpsByCoord/profileMap
  // change. Lookup is O(1) per event by coord.
  const summaryFor = useMemo(() => {
    return (parsed) => {
      if (!parsed) return null
      const coord = coordOf(parsed)
      const list = rsvpsByCoord.get(coord)
      if (!list || list.length === 0) {
        return { goingCount: 0, maybeCount: 0, decliningCount: 0, acceptedTop: [] }
      }
      let goingCount = 0, maybeCount = 0, decliningCount = 0
      const acceptedTop = []
      for (const r of list) {
        if (r.status === 'accepted') {
          goingCount++
          if (acceptedTop.length < AVATARS_PER_EVENT) {
            acceptedTop.push({ pubkey: r.pubkey, profile: profileMap.get(r.pubkey) || null })
          }
        } else if (r.status === 'tentative')  maybeCount++
        else if (r.status === 'declined')     decliningCount++
      }
      return { goingCount, maybeCount, decliningCount, acceptedTop }
    }
  }, [rsvpsByCoord, profileMap])

  return { summaryFor, loading }
}
