/**
 * useEventDrafts — multi-draft store for the events composer.
 *
 * Direct port of useSellDrafts (marketplace) so the tray UI / wiring
 * stays structurally identical. Each draft holds the full event-form
 * snapshot from emptyEventForm(); publish derives the spec-compliant
 * shape via formToPublishShape at publish time (no separate cache —
 * the snapshot has everything publishCalendarEvent needs).
 *
 * Storage keys:
 *   mynostr_event_drafts_<pubkey>          → array of drafts
 *   mynostr_event_current_draft_<pubkey>   → currently-selected draft id
 *
 * Replaceable kind semantics: kind 31922/31923 are addressable per
 * (kind, pubkey, dTag). Two drafts sharing a dTag will silently
 * overwrite each other on publish — the tray's findDuplicateDTags
 * UI catches this before the publish-all confirm.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptyEventForm, formToPublishShape, isEventFormMeaningful } from './eventForm.js'
import { publishCalendarEvent } from './eventPublish.js'

const LIST_KEY    = 'mynostr_event_drafts_'
const CURRENT_KEY = 'mynostr_event_current_draft_'
const DEBOUNCE_MS = 400
const CAP = 50
// Same byte-budget logic as useSellDrafts: localStorage has a per-origin
// ~5 MB ceiling and serialized events with image URLs + markdown can be
// sizable, so cap the payload below the budget and shed oldest drafts
// to fit.
const MAX_PAYLOAD_BYTES = 4_000_000

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Produce a fresh draft. Pass `{ snapshot }` to seed with a populated
 * form (used by import / load-from-naddr to create a draft from an
 * existing event).
 */
export function makeEventDraft(patch = {}) {
  const now = Date.now()
  const { snapshot: patchSnapshot, ...rest } = patch
  return {
    id:        genId(),
    snapshot:  { ...emptyEventForm(), ...(patchSnapshot || {}) },
    status:    'draft',          // 'draft' | 'publishing' | 'published' | 'failed'
    publishError:  null,
    publishResult: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  }
}

export function useEventDrafts(pubkey) {
  const listKey = pubkey ? `${LIST_KEY}${pubkey}` : null
  const curKey  = pubkey ? `${CURRENT_KEY}${pubkey}` : null

  const [drafts, setDrafts] = useState([])
  const [currentDraftId, setCurrentId] = useState(null)
  const hydrated = useRef(false)
  const persistTimer = useRef(null)
  const publishAllCancelled = useRef(false)

  // Hydrate once from storage, or seed an empty draft.
  // Validates each parsed draft's shape so a corrupted/tampered/
  // version-skewed localStorage payload can't crash the composer at
  // render time. Drafts missing id or snapshot are dropped; if the
  // entire array is corrupt we fall through to a fresh seed.
  useEffect(() => {
    if (!listKey) return
    let next = null
    let nextCurrent = null
    try {
      const raw = localStorage.getItem(listKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length) {
          const valid = parsed
            .filter(d =>
              d &&
              typeof d === 'object' &&
              typeof d.id === 'string' &&
              d.id.length > 0 &&
              d.snapshot &&
              typeof d.snapshot === 'object'
            )
            // Reset orphan "publishing" state from a prior crash so the
            // tray doesn't perpetually show a spinner on a draft whose
            // publish never completed. Spread emptyEventForm() over each
            // snapshot so missing fields from older draft formats get
            // their defaults rather than rendering as undefined.
            .map(d => ({
              ...d,
              snapshot: { ...emptyEventForm(), ...d.snapshot },
              status: d.status === 'publishing' ? 'draft' : (d.status || 'draft'),
            }))
          if (valid.length > 0) next = valid
        }
      }
      nextCurrent = localStorage.getItem(curKey) || null
    } catch {}
    if (!next) {
      const first = makeEventDraft()
      next = [first]
      nextCurrent = first.id
    } else if (!next.some(d => d.id === nextCurrent)) {
      nextCurrent = next[0].id
    }
    setDrafts(next)
    setCurrentId(nextCurrent)
    hydrated.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey])

  // Debounced persist. Skipped until hydration so we don't overwrite
  // storage with the empty initial state before reading it.
  useEffect(() => {
    if (!listKey || !hydrated.current) return
    clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      try {
        let slice = drafts.slice(-CAP)
        let serialized = JSON.stringify(slice)
        while (serialized.length > MAX_PAYLOAD_BYTES && slice.length > 1) {
          slice = slice.slice(1)
          serialized = JSON.stringify(slice)
        }
        localStorage.setItem(listKey, serialized)
        if (currentDraftId) localStorage.setItem(curKey, currentDraftId)
      } catch {}
    }, DEBOUNCE_MS)
    return () => clearTimeout(persistTimer.current)
  }, [drafts, currentDraftId, listKey, curKey])

  const currentDraft = useMemo(
    () => drafts.find(d => d.id === currentDraftId) || null,
    [drafts, currentDraftId]
  )

  const createDraft = useCallback((patch) => {
    const d = makeEventDraft(patch)
    setDrafts(prev => [...prev, d])
    setCurrentId(d.id)
    return d
  }, [])

  const updateDraftWith = useCallback((id, fn) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...fn(d), updatedAt: Date.now() } : d))
  }, [])

  const updateDraft = useCallback((id, patch) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d))
  }, [])

  // Replace the current draft's snapshot wholesale. Used when the
  // composer overwrites the form (e.g. on a load-from-naddr that
  // targets the current draft slot rather than creating a new one).
  // Bumps `replaceVersion` so consumers can use it as a remount key —
  // children that lazy-init their internal state from props (the
  // location autocomplete's picked-coords, the time picker's slot
  // selection) need a fresh mount when the underlying snapshot is
  // replaced; keying on draft.id alone keeps the same key across
  // replaces.
  const replaceSnapshot = useCallback((id, snapshot) => {
    updateDraftWith(id, (d) => ({
      ...d,
      snapshot,
      replaceVersion: (d.replaceVersion || 0) + 1,
    }))
  }, [updateDraftWith])

  const deleteDraft = useCallback((id) => {
    setDrafts(prev => {
      const filtered = prev.filter(d => d.id !== id)
      if (filtered.length === 0) {
        const fresh = makeEventDraft()
        setCurrentId(fresh.id)
        return [fresh]
      }
      setCurrentId(curr => curr === id ? filtered[0].id : curr)
      return filtered
    })
  }, [])

  const clearDraft = useCallback((id) => {
    updateDraftWith(id, (d) => ({
      ...d,
      snapshot: emptyEventForm(),
      status:   'draft',
      publishError: null,
      publishResult: null,
    }))
  }, [updateDraftWith])

  const deleteAllDrafts = useCallback(() => {
    const fresh = makeEventDraft()
    setDrafts([fresh])
    setCurrentId(fresh.id)
  }, [])

  const clearPublished = useCallback(() => {
    setDrafts(prev => {
      const filtered = prev.filter(d => d.status !== 'published')
      if (filtered.length === 0) {
        const fresh = makeEventDraft()
        setCurrentId(fresh.id)
        return [fresh]
      }
      setCurrentId(curr => filtered.some(d => d.id === curr) ? curr : filtered[0].id)
      return filtered
    })
  }, [])

  const moveDraft = useCallback((id, delta) => {
    setDrafts(prev => {
      const idx = prev.findIndex(d => d.id === id)
      if (idx < 0) return prev
      const target = idx + delta
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      const [item] = next.splice(idx, 1)
      next.splice(target, 0, item)
      return next
    })
  }, [])

  const publishOne = useCallback(async (id) => {
    const target = drafts.find(d => d.id === id)
    if (!target) return { ok: false, reason: 'not-found' }
    const form = target.snapshot
    if (!isEventFormMeaningful(form)) return { ok: false, reason: 'empty' }
    if (!form.title?.trim())          return { ok: false, reason: 'no-title' }
    if (!form.startDate)              return { ok: false, reason: 'no-start' }

    updateDraft(id, { status: 'publishing', publishError: null })
    try {
      const lowered = formToPublishShape(form)
      const result = await publishCalendarEvent(lowered)
      // Carry the resolved dTag back into the snapshot so future edits
      // of the same draft replace this event rather than spawning a
      // new one. linkedEventTitle stamps the (now-published) title so
      // the publish-identity banner reads cleanly even after a rename.
      updateDraftWith(id, (d) => ({
        ...d,
        status: 'published',
        snapshot: { ...d.snapshot, dTag: result.dTag, linkedEventTitle: form.title.trim() },
        publishResult: result,
        publishError: null,
      }))
      return { ok: true, result, dTag: result.dTag }
    } catch (e) {
      updateDraft(id, { status: 'failed', publishError: e?.message || 'Publish failed' })
      return { ok: false, error: e }
    }
  }, [drafts, updateDraft, updateDraftWith])

  // Drafts in the queue that share a dTag with another draft. Kind
  // 31922/31923 is replaceable per (kind, pubkey, dTag), so two
  // drafts with the same dTag would overwrite each other on publish.
  // Canonical failure mode: importing the same JSON template multiple
  // times with the dTag preserved (we strip dTag on JSON import to
  // prevent this; foreign data or older drafts may still trip it).
  const findDuplicateDTags = useCallback(() => {
    const queue = drafts.filter(d =>
      isEventFormMeaningful(d.snapshot) && d.snapshot.title?.trim() && d.status !== 'published'
    )
    const byTag = new Map()
    for (const d of queue) {
      const tag = d.snapshot?.dTag
      if (!tag) continue
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push({ id: d.id, title: d.snapshot.title || '' })
    }
    const dups = []
    for (const [tag, ds] of byTag) {
      if (ds.length > 1) dups.push({ dTag: tag, drafts: ds })
    }
    return dups
  }, [drafts])

  // Strip dTag (and the linked-event title that pairs with it) from a
  // set of drafts so they publish as fresh events. publishCalendarEvent
  // generates a new random dTag when form.dTag is empty. Used by the
  // dup-dTag recovery flow in the tray.
  const regenerateDTags = useCallback((ids) => {
    const idSet = new Set(ids)
    setDrafts(prev => prev.map(d =>
      idSet.has(d.id)
        ? {
            ...d,
            snapshot: { ...d.snapshot, dTag: '', linkedEventTitle: '' },
            updatedAt: Date.now(),
          }
        : d
    ))
  }, [])

  const publishAll = useCallback(async () => {
    publishAllCancelled.current = false
    // Belt-and-suspenders dup check at the lib layer — the tray UI
    // catches this earlier with a more helpful modal.
    const dups = findDuplicateDTags()
    if (dups.length > 0) {
      return { ok: false, reason: 'duplicate-dtags', dups, results: [] }
    }
    const queue = drafts.filter(d =>
      isEventFormMeaningful(d.snapshot) && d.snapshot.title?.trim() && d.snapshot.startDate && d.status !== 'published'
    )
    const results = []
    for (const d of queue) {
      if (publishAllCancelled.current) break
      // eslint-disable-next-line no-await-in-loop
      const r = await publishOne(d.id)
      results.push({ id: d.id, ...r })
    }
    return { ok: true, results }
  }, [drafts, publishOne, findDuplicateDTags])

  const cancelPublishAll = useCallback(() => {
    publishAllCancelled.current = true
  }, [])

  return {
    drafts,
    currentDraft,
    currentDraftId,
    setCurrentDraftId: setCurrentId,
    createDraft,
    updateDraft,
    updateDraftWith,
    replaceSnapshot,
    deleteDraft,
    deleteAllDrafts,
    clearDraft,
    clearPublished,
    moveDraft,
    findDuplicateDTags,
    regenerateDTags,
    publishOne,
    publishAll,
    cancelPublishAll,
  }
}
