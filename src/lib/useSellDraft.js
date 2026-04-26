import { useRef, useCallback } from 'react'

const DRAFT_KEY_PREFIX = 'mynostr_sell_draft_'
const DEBOUNCE_MS = 500

/**
 * Single-draft autosave for the marketplace Sell composer.
 *
 * Same shape as `useDraft` (Articles): debounced writes, keyed per
 * pubkey so multiple users on the same machine don't collide. We start
 * with single-draft because most listings are one at a time; the multi-
 * draft tray pattern Notes uses isn't justified yet and can be added
 * later without changing the composer's saveDraft signature.
 *
 * The persisted shape is the gamma-form (the same form you pass to
 * encodeProduct), augmented with savedAt for the "draft restored x
 * minutes ago" affordance.
 */
export function useSellDraft(pubkey) {
  const timerRef = useRef(null)
  const storageKey = pubkey ? `${DRAFT_KEY_PREFIX}${pubkey}` : null

  // Heuristic for "anything worth saving" — typing a title alone is
  // enough; a stray keystroke in description without title isn't,
  // because that'd persist garbage drafts on refresh-after-noop.
  const isMeaningful = (form) => {
    if (!form) return false
    if (form.title && form.title.trim()) return true
    if (form.summary && form.summary.trim()) return true
    if (form.content && form.content.trim()) return true
    if (Array.isArray(form.images) && form.images.some(i => i?.url)) return true
    return false
  }

  const saveDraft = useCallback((form) => {
    if (!storageKey) return
    if (!isMeaningful(form)) {
      clearTimeout(timerRef.current)
      try { localStorage.removeItem(storageKey) } catch {}
      return
    }
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ form, savedAt: Date.now() }))
      } catch {
        // localStorage unavailable / full — fail silently
      }
    }, DEBOUNCE_MS)
  }, [storageKey])

  const loadDraft = useCallback(() => {
    if (!storageKey) return null
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }, [storageKey])

  const clearDraft = useCallback(() => {
    if (!storageKey) return
    clearTimeout(timerRef.current)
    try { localStorage.removeItem(storageKey) } catch {}
  }, [storageKey])

  return { saveDraft, loadDraft, clearDraft }
}
