import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { publishNote } from './publishNote.js'
import { clearThreadCache } from './useNoteThread.js'

const LIST_KEY = 'mynostr_notes_drafts_'
const CURRENT_KEY = 'mynostr_notes_current_draft_'
const DEBOUNCE_MS = 400
const CAP = 50
// localStorage has a per-origin budget (~5 MB in most browsers, often less
// on mobile). If the serialized draft list blows past this, `setItem` throws
// and — because we swallow the error — persists stop silently from that
// point on. Cap the payload at 4 MB (well under the typical ceiling) and
// shed oldest drafts until it fits so at least the newest work survives.
const MAX_PAYLOAD_BYTES = 4_000_000

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const DEFAULT_SNAPSHOT = {
  content: '',
  zapSplits: [],
  userZapPct: null,
  manualTags: [],
  mentions: {},
  replyToInput: '',
  replyTarget: null,
  quoteInput: '',
  quoteTarget: null,
  relayOverride: { enabled: false, relays: [] },
  publishAt: null,
}

// Shape of each draft. Keep raw form-state under `snapshot` so the composer
// can rehydrate on remount; `publishable` is the pre-computed {content, tags}
// the composer emits so Publish-all can skip re-mounting each draft.
// `patch.snapshot` is merged with the default snapshot so prefill callers
// only need to pass the fields they care about.
export function makeDraft(patch = {}) {
  const now = Date.now()
  const { snapshot: patchSnapshot, ...rest } = patch
  return {
    id: genId(),
    snapshot: { ...DEFAULT_SNAPSHOT, ...(patchSnapshot || {}) },
    publishable: null,
    status: 'draft',          // 'draft' | 'publishing' | 'published' | 'failed'
    publishError: null,
    publishResult: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  }
}

/**
 * Manages an array of drafts in localStorage, keyed by pubkey. Each draft
 * is a self-contained unit the composer hydrates from. `publishOne` and
 * `publishAll` use the draft's cached `publishable` so batch publishing
 * doesn't require opening each draft.
 */
export function useNoteDrafts(pubkey) {
  const listKey = pubkey ? `${LIST_KEY}${pubkey}` : null
  const curKey = pubkey ? `${CURRENT_KEY}${pubkey}` : null

  const [drafts, setDrafts] = useState([])
  const [currentDraftId, setCurrentId] = useState(null)
  const hydrated = useRef(false)
  const persistTimer = useRef(null)
  const publishAllCancelled = useRef(false)

  // Hydrate once from storage (or seed one empty draft).
  useEffect(() => {
    if (!listKey) return
    let next = null
    let nextCurrent = null
    try {
      const raw = localStorage.getItem(listKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length) {
          next = parsed.map(d => ({
            ...d,
            // Reset any orphan "publishing" state from a prior crash
            status: d.status === 'publishing' ? 'draft' : d.status,
          }))
        }
      }
      nextCurrent = localStorage.getItem(curKey) || null
    } catch {}
    if (!next) {
      const first = makeDraft()
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

  // Debounced persist. Only after hydration so we don't overwrite storage
  // with the initial empty state before we've read it back.
  useEffect(() => {
    if (!listKey || !hydrated.current) return
    clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      try {
        // Shed oldest drafts (front of the array) until the serialized
        // payload fits inside MAX_PAYLOAD_BYTES. Count cap (CAP) is the
        // first filter; byte cap handles a single huge draft breaching
        // the budget on its own.
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
    const d = makeDraft(patch)
    setDrafts(prev => [...prev, d])
    setCurrentId(d.id)
    return d
  }, [])

  const updateDraft = useCallback((id, patch) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d))
  }, [])

  // Atomic update — pass a function that produces the next draft state.
  // Avoids stale-closure bugs when callers chain patches.
  const updateDraftWith = useCallback((id, fn) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...fn(d), updatedAt: Date.now() } : d))
  }, [])

  const deleteDraft = useCallback((id) => {
    setDrafts(prev => {
      const filtered = prev.filter(d => d.id !== id)
      if (filtered.length === 0) {
        const fresh = makeDraft()
        setCurrentId(fresh.id)
        return [fresh]
      }
      setCurrentId(curr => curr === id ? filtered[0].id : curr)
      return filtered
    })
  }, [])

  // Reset current draft to empty — used by the Clear button.
  const clearDraft = useCallback((id) => {
    updateDraftWith(id, (d) => ({
      ...d,
      snapshot: makeDraft().snapshot,
      publishable: null,
      status: 'draft',
      publishError: null,
      publishResult: null,
    }))
  }, [updateDraftWith])

  // Publish a single draft using its cached publishable. Updates status in
  // place so the tray + composer can show the spinner without re-renders
  // from elsewhere. Returns {ok} so callers can chain.
  const publishOne = useCallback(async (id) => {
    const target = drafts.find(d => d.id === id)
    if (!target) return { ok: false, reason: 'not-found' }
    const pub = target.publishable
    if (!pub || !pub.content?.trim()) return { ok: false, reason: 'empty' }

    updateDraft(id, { status: 'publishing', publishError: null })
    const ov = target.snapshot?.relayOverride
    const relayOverride = ov?.enabled && ov.relays?.length ? ov.relays : null
    try {
      const result = await publishNote({ content: pub.content, tags: pub.tags, relayOverride })
      updateDraft(id, { status: 'published', publishResult: result, publishError: null })
      // Invalidate thread cache so re-entering a thread the user just
      // replied in shows the fresh view (Primal lag would otherwise
      // serve a stale snapshot from cache for the rest of the session).
      try { clearThreadCache() } catch {}
      return { ok: true, result }
    } catch (e) {
      updateDraft(id, { status: 'failed', publishError: e?.message || 'Publish failed' })
      return { ok: false, error: e }
    }
  }, [drafts, updateDraft])

  const publishAll = useCallback(async () => {
    publishAllCancelled.current = false
    const queue = drafts.filter(d => d.publishable?.content?.trim() && d.status !== 'published')
    const results = []
    for (const d of queue) {
      if (publishAllCancelled.current) break
      // eslint-disable-next-line no-await-in-loop
      const r = await publishOne(d.id)
      results.push({ id: d.id, ...r })
    }
    return results
  }, [drafts, publishOne])

  const cancelPublishAll = useCallback(() => {
    publishAllCancelled.current = true
  }, [])

  // Wipe every draft and seed a fresh empty one — "Clear all drafts" in the tray.
  const deleteAllDrafts = useCallback(() => {
    const fresh = makeDraft()
    setDrafts([fresh])
    setCurrentId(fresh.id)
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

  // Remove all drafts whose last publish succeeded — cleanup after a batch.
  const clearPublished = useCallback(() => {
    setDrafts(prev => {
      const filtered = prev.filter(d => d.status !== 'published')
      if (filtered.length === 0) {
        const fresh = makeDraft()
        setCurrentId(fresh.id)
        return [fresh]
      }
      setCurrentId(curr => filtered.some(d => d.id === curr) ? curr : filtered[0].id)
      return filtered
    })
  }, [])

  return {
    drafts,
    currentDraft,
    currentDraftId,
    setCurrentDraftId: setCurrentId,
    createDraft,
    updateDraft,
    updateDraftWith,
    deleteDraft,
    deleteAllDrafts,
    clearDraft,
    moveDraft,
    publishOne,
    publishAll,
    cancelPublishAll,
    clearPublished,
  }
}
