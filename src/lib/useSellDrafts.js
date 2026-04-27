import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptySellForm, formToGammaForm, isFormMeaningful } from './sellForm.js'
import { publishProduct } from './publishProduct.js'

const LIST_KEY    = 'mynostr_sell_drafts_'
const CURRENT_KEY = 'mynostr_sell_current_draft_'
const DEBOUNCE_MS = 400
const CAP = 50
// Same byte-budget logic as useNoteDrafts: localStorage has a per-origin
// ~5 MB ceiling and serialized listings (with image URLs + markdown) can
// be sizable, so cap the payload below the budget and shed oldest drafts
// to fit.
const MAX_PAYLOAD_BYTES = 4_000_000

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Produce a fresh draft. Pass `{ snapshot }` to seed with a populated
 * form (used by import / load-from-naddr to create a draft from an
 * existing event). Other patch keys (status, etc.) flow through
 * directly so callers can mark imported drafts as 'draft' explicitly.
 */
export function makeSellDraft(patch = {}) {
  const now = Date.now()
  const { snapshot: patchSnapshot, ...rest } = patch
  return {
    id:        genId(),
    snapshot:  { ...emptySellForm(), ...(patchSnapshot || {}) },
    status:    'draft',          // 'draft' | 'publishing' | 'published' | 'failed'
    publishError:  null,
    publishResult: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  }
}

/**
 * Multi-draft store for marketplace listings. Mirrors useNoteDrafts so
 * the tray UI can stay structurally identical. Each draft holds the
 * full sell-form snapshot; publish derives the gamma encode shape via
 * formToGammaForm at publish time (no separate `publishable` cache —
 * the form snapshot has everything the publisher needs).
 */
export function useSellDrafts(pubkey) {
  const listKey = pubkey ? `${LIST_KEY}${pubkey}` : null
  const curKey  = pubkey ? `${CURRENT_KEY}${pubkey}` : null

  const [drafts, setDrafts] = useState([])
  const [currentDraftId, setCurrentId] = useState(null)
  const hydrated = useRef(false)
  const persistTimer = useRef(null)
  const publishAllCancelled = useRef(false)

  // Hydrate once from storage, or seed an empty draft.
  useEffect(() => {
    if (!listKey) return
    let next = null
    let nextCurrent = null
    try {
      const raw = localStorage.getItem(listKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length) {
          // Reset orphan "publishing" state from a prior crash so the
          // tray doesn't perpetually show a spinner on a draft whose
          // publish never completed.
          next = parsed.map(d => ({
            ...d,
            status: d.status === 'publishing' ? 'draft' : d.status,
          }))
        }
      }
      nextCurrent = localStorage.getItem(curKey) || null
    } catch {}
    if (!next) {
      const first = makeSellDraft()
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
    const d = makeSellDraft(patch)
    setDrafts(prev => [...prev, d])
    setCurrentId(d.id)
    return d
  }, [])

  // Atomic update — pass a function so chained patches don't see stale
  // state. Mirrors useNoteDrafts's updateDraftWith.
  const updateDraftWith = useCallback((id, fn) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...fn(d), updatedAt: Date.now() } : d))
  }, [])

  const updateDraft = useCallback((id, patch) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d))
  }, [])

  // Replace the current draft's snapshot wholesale. Used when the
  // composer overwrites the form (e.g. on a load-from-naddr that
  // targets the current draft slot rather than creating a new one).
  //
  // Bumps `replaceVersion` so consumers can use it as a remount key.
  // Children that lazy-init their internal state from props on mount
  // (PriceField, anything similar) need a fresh mount when the
  // underlying snapshot is replaced — keying on draft.id alone keeps
  // the same key across replaces and leaves stale internal state.
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
        const fresh = makeSellDraft()
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
      snapshot: emptySellForm(),
      status:   'draft',
      publishError: null,
      publishResult: null,
    }))
  }, [updateDraftWith])

  const deleteAllDrafts = useCallback(() => {
    const fresh = makeSellDraft()
    setDrafts([fresh])
    setCurrentId(fresh.id)
  }, [])

  const clearPublished = useCallback(() => {
    setDrafts(prev => {
      const filtered = prev.filter(d => d.status !== 'published')
      if (filtered.length === 0) {
        const fresh = makeSellDraft()
        setCurrentId(fresh.id)
        return [fresh]
      }
      setCurrentId(curr => filtered.some(d => d.id === curr) ? curr : filtered[0].id)
      return filtered
    })
  }, [])

  // Reorder a draft up/down in the queue. `delta` is -1 (up) or +1 (down).
  // No-op when the move would land out of bounds. The publish queue follows
  // array order, so this directly controls publication sequence.
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
    if (!isFormMeaningful(form))     return { ok: false, reason: 'empty' }
    if (!form.title?.trim())         return { ok: false, reason: 'no-title' }

    updateDraft(id, { status: 'publishing', publishError: null })
    try {
      const gamma = formToGammaForm(form)
      const result = await publishProduct(gamma)
      // Carry the resolved dTag back into the snapshot so future edits
      // of the same draft replace this listing rather than spawning a
      // new one each time.
      updateDraftWith(id, (d) => ({
        ...d,
        status: 'published',
        snapshot: { ...d.snapshot, dTag: gamma.dTag },
        publishResult: result,
        publishError: null,
      }))
      // Surface the resolved dTag to callers (SellComposer's post-publish
      // collection sync needs it to compute the product coordinate).
      return { ok: true, result, dTag: gamma.dTag }
    } catch (e) {
      updateDraft(id, { status: 'failed', publishError: e?.message || 'Publish failed' })
      return { ok: false, error: e }
    }
  }, [drafts, updateDraft, updateDraftWith])

  // Find drafts in the queue that share a dTag with another draft.
  // Returns [{ dTag, drafts: [{id, title}] }] — empty array when none.
  // Kind 30402 is replaceable per (kind, pubkey, dTag), so two drafts
  // with the same dTag would overwrite each other on publish — almost
  // never the user's intent (template-import workflow accidentally
  // shares a dTag across drafts is the canonical failure mode).
  const findDuplicateDTags = useCallback(() => {
    const queue = drafts.filter(d =>
      isFormMeaningful(d.snapshot) && d.snapshot.title?.trim() && d.status !== 'published'
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

  // Strip dTag (and the linked-listing title that pairs with it) from
  // a set of drafts so they publish as fresh listings (formToGammaForm
  // generates a new slug-style dTag when form.dTag is empty). Used by
  // the dup-dTag recovery flow in the tray. Clearing linkedListingTitle
  // alongside dTag keeps the form's "publish identity" state consistent
  // — the banner reads dTag first, but a stale linkedListingTitle would
  // be wrong if any future code path consulted it independently.
  const regenerateDTags = useCallback((ids) => {
    const idSet = new Set(ids)
    setDrafts(prev => prev.map(d =>
      idSet.has(d.id)
        ? {
            ...d,
            snapshot: { ...d.snapshot, dTag: '', linkedListingTitle: '' },
            updatedAt: Date.now(),
          }
        : d
    ))
  }, [])

  const publishAll = useCallback(async () => {
    publishAllCancelled.current = false
    // Belt-and-suspenders dup check at the lib layer — the tray UI
    // catches this earlier with a more helpful modal, but a non-UI
    // caller (future scheduler, automation) shouldn't be able to
    // trigger an overwrite cascade by accident.
    const dups = findDuplicateDTags()
    if (dups.length > 0) {
      return { ok: false, reason: 'duplicate-dtags', dups, results: [] }
    }
    const queue = drafts.filter(d =>
      isFormMeaningful(d.snapshot) && d.snapshot.title?.trim() && d.status !== 'published'
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
