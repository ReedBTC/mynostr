/**
 * useEventCalendars — fetch + mutate a user's kind 31924 calendar lists.
 *
 * Modeled directly on useCollections (marketplace gamma collections).
 * Each user can have any number of calendars; replaceable per
 * (31924, pubkey, dTag). Watch out: writing only makes sense when
 * pubkey === sessionUser.pubkey — mutators sign with the NDK signer
 * and the relay drops mismatched-author publishes.
 *
 * Multi-tab mutation race (known limitation, accepted):
 * Each mutation reads `existing` from local state → builds `next` →
 * publishes a fresh kind-31924. If the user has two tabs open and
 * each adds a different event to the SAME calendar before the
 * relay-roundtrip from the other tab arrives, the second tab's
 * republish overwrites the first — silently. Last-writer-wins.
 *
 * Same class of bug exists in marketplace's useCollections by design;
 * fixing properly needs either (a) a refetch-before-publish dance per
 * mutation (extra round-trip cost) or (b) a live subscription so each
 * tab pulls in the others' writes. We've accepted the tradeoff for
 * now — multi-tab calendar editing is rare, and the obvious symptom
 * (an event going missing) prompts the user to re-add. Revisit if it
 * becomes a real complaint.
 */
import { useCallback, useEffect, useState } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'
import { withTimeout, isSafeUrl } from './utils.js'
import {
  KIND_CALENDAR,
  encodeCalendar,
  decodeCalendar,
} from './calendarLists.js'

function generateCalendarDTag(title) {
  const base = String(title || 'calendar').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'calendar'
  const suffix = Math.random().toString(36).slice(2, 7)
  return `${base}-${suffix}`
}

async function fetchAllCalendars(pubkey) {
  if (!pubkey) return []
  const ndk = getNDK()
  try {
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds:   [KIND_CALENDAR],
        authors: [pubkey],
      }),
      8000,
      'fetch-timeout',
    )
    // Replaceable kind — dedupe by dTag, keep newest by created_at.
    const byDTag = new Map()
    for (const ev of events) {
      const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
      if (!dTag) continue
      const existing = byDTag.get(dTag)
      if (!existing || (ev.created_at || 0) > (existing.created_at || 0)) {
        byDTag.set(dTag, ev)
      }
    }
    const out = []
    for (const ev of byDTag.values()) {
      const decoded = decodeCalendar(ev)
      if (decoded) out.push({ event: ev, decoded })
    }
    out.sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
    return out
  } catch {
    return []
  }
}

export function useEventCalendars(pubkey) {
  const [calendars, setCalendars] = useState([])  // [{ event, decoded }]
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [token,     setToken]     = useState(0)
  const [pending,   setPending]   = useState(false)

  const reload = useCallback(() => setToken(t => t + 1), [])

  useEffect(() => {
    if (!pubkey) {
      setCalendars([])
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const all = await fetchAllCalendars(pubkey)
        if (cancelled) return
        setCalendars(all)
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e?.message || 'Calendars load failed.')
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, token])

  // ── Lookups ─────────────────────────────────────────────────────────

  const find = useCallback((dTag) => {
    if (!dTag) return null
    return calendars.find(c => c.decoded.dTag === dTag) || null
  }, [calendars])

  /** Returns the dTags of calendars that contain the given event coord. */
  const containingCalendars = useCallback((eventCoord) => {
    if (!eventCoord) return []
    return calendars
      .filter(c => (c.decoded.eventRefs || []).includes(eventCoord))
      .map(c => c.decoded.dTag)
  }, [calendars])

  // ── Internal: build + sign + publish a 31924 from a decoded shape ──

  const publishCalendarEvent = useCallback(async (form) => {
    const ndk = getNDK()
    if (!ndk?.signer) throw new Error('No signer available')
    const { kind, content, tags } = encodeCalendar(form)
    const ev = new NDKEvent(ndk, {
      kind,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    })
    await signWithTimeout(ev)
    await publishToOwnOutbox(ev)
    return ev
  }, [])

  // Update the local state by dTag, preserving array shape.
  const upsertLocal = useCallback((decoded, eventOverride) => {
    setCalendars(prev => {
      const others = prev.filter(c => c.decoded.dTag !== decoded.dTag)
      const entry = {
        event: eventOverride || (prev.find(c => c.decoded.dTag === decoded.dTag)?.event) || null,
        decoded,
      }
      const next = [...others, entry]
      next.sort((a, b) => ((b.event?.created_at) || 0) - ((a.event?.created_at) || 0))
      return next
    })
  }, [])

  // ── Mutators ────────────────────────────────────────────────────────

  /** Create a new calendar list. */
  const createCalendar = useCallback(async ({ title, summary = '', image = '', eventRefs = [] }) => {
    if (pending) return { ok: false, reason: 'busy' }
    if (!title?.trim()) return { ok: false, error: 'Title required' }
    const cleanImage = image?.trim() || ''
    if (cleanImage && !isSafeUrl(cleanImage)) {
      return { ok: false, error: 'Cover image must be a valid https:// URL.' }
    }
    setPending(true)
    setError(null)
    try {
      const dTag = generateCalendarDTag(title)
      const decoded = {
        dTag,
        title: title.trim(),
        summary: summary?.trim() || '',
        image: cleanImage,
        eventRefs,
        _extraTags: [],
      }
      const ev = await publishCalendarEvent(decoded)
      upsertLocal(decoded, ev)
      return { ok: true, dTag }
    } catch (e) {
      setError(e?.message || 'Create failed.')
      return { ok: false, error: e?.message || 'Create failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, publishCalendarEvent, upsertLocal])

  /** Update a calendar's metadata. Preserves eventRefs unless the patch overrides. */
  const updateMetadata = useCallback(async (dTag, patch) => {
    if (!dTag || pending) return { ok: false, reason: 'busy-or-empty' }
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'image')) {
      const cleanImage = (patch.image || '').trim()
      if (cleanImage && !isSafeUrl(cleanImage)) {
        return { ok: false, error: 'Cover image must be a valid https:// URL.' }
      }
    }
    setPending(true)
    setError(null)
    try {
      const existing = calendars.find(c => c.decoded.dTag === dTag)?.decoded
      const baseline = existing || {
        dTag, title: 'Calendar', summary: '', image: '', eventRefs: [], _extraTags: [],
      }
      const next = {
        ...baseline,
        ...patch,
        dTag,
        title: patch.title?.trim() || baseline.title || 'Calendar',
      }
      const ev = await publishCalendarEvent(next)
      upsertLocal(next, ev)
      return { ok: true }
    } catch (e) {
      setError(e?.message || 'Update failed.')
      return { ok: false, error: e?.message || 'Update failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, calendars, publishCalendarEvent, upsertLocal])

  /** Add an event coord to a calendar. Auto-creates if absent. */
  const addToCalendar = useCallback(async (dTag, eventCoord) => {
    if (!dTag || !eventCoord || pending) return { ok: false, reason: 'busy-or-empty' }
    const existing = calendars.find(c => c.decoded.dTag === dTag)?.decoded
    if (existing && (existing.eventRefs || []).includes(eventCoord)) {
      return { ok: true, alreadyPresent: true }
    }
    setPending(true)
    setError(null)
    try {
      const baseline = existing || {
        dTag, title: 'Calendar', summary: '', image: '', eventRefs: [], _extraTags: [],
      }
      const next = {
        ...baseline,
        eventRefs: [...(baseline.eventRefs || []), eventCoord],
      }
      const ev = await publishCalendarEvent(next)
      upsertLocal(next, ev)
      return { ok: true }
    } catch (e) {
      setError(e?.message || 'Add failed.')
      return { ok: false, error: e?.message || 'Add failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, calendars, publishCalendarEvent, upsertLocal])

  /** Remove an event coord from a calendar. No-op if not present. */
  const removeFromCalendar = useCallback(async (dTag, eventCoord) => {
    if (!dTag || !eventCoord || pending) return { ok: false, reason: 'busy-or-empty' }
    const existing = calendars.find(c => c.decoded.dTag === dTag)?.decoded
    if (!existing) return { ok: true, alreadyAbsent: true }
    if (!(existing.eventRefs || []).includes(eventCoord)) {
      return { ok: true, alreadyAbsent: true }
    }
    setPending(true)
    setError(null)
    try {
      const next = {
        ...existing,
        eventRefs: (existing.eventRefs || []).filter(r => r !== eventCoord),
      }
      const ev = await publishCalendarEvent(next)
      upsertLocal(next, ev)
      return { ok: true }
    } catch (e) {
      setError(e?.message || 'Remove failed.')
      return { ok: false, error: e?.message || 'Remove failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, calendars, publishCalendarEvent, upsertLocal])

  /** Delete a calendar via NIP-09 kind 5. */
  const deleteCalendar = useCallback(async (dTag) => {
    if (!dTag || pending) return { ok: false, reason: 'busy-or-empty' }
    const ndk = getNDK()
    if (!ndk?.signer) return { ok: false, error: 'Not signed in' }
    const me = ndk.activeUser?.pubkey
    if (!me) return { ok: false, error: 'No active user' }
    const target = calendars.find(c => c.decoded.dTag === dTag)
    if (!target) return { ok: true, alreadyAbsent: true }

    setPending(true)
    setError(null)
    try {
      const tags = []
      if (target.event?.id) tags.push(['e', target.event.id])
      tags.push(['a', `${KIND_CALENDAR}:${me}:${dTag}`])
      tags.push(['k', String(KIND_CALENDAR)])
      tags.push(['client', 'mynostr'])
      const ev = new NDKEvent(ndk, {
        kind: 5,
        content: '',
        tags,
        created_at: Math.floor(Date.now() / 1000),
      })
      await signWithTimeout(ev)
      await publishToOwnOutbox(ev)
      // Drop locally regardless of relay propagation.
      setCalendars(prev => prev.filter(c => c.decoded.dTag !== dTag))
      return { ok: true }
    } catch (e) {
      setError(e?.message || 'Delete failed.')
      return { ok: false, error: e?.message || 'Delete failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, calendars])

  return {
    calendars,
    loading,
    error,
    pending,
    reload,
    find,
    containingCalendars,
    createCalendar,
    updateMetadata,
    addToCalendar,
    removeFromCalendar,
    deleteCalendar,
  }
}
