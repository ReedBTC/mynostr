import { storageKey } from './brand.js'
import { useRef, useCallback } from 'react'

const DRAFT_KEY_PREFIX = storageKey('draft_')
const DEBOUNCE_MS = 500

// Persists editor state to localStorage, keyed per pubkey so multiple
// users on the same machine don't see each other's drafts.
export function useDraft(pubkey) {
  const timerRef = useRef(null)
  const draftKey = pubkey ? `${DRAFT_KEY_PREFIX}${pubkey}` : null

  const saveDraft = useCallback((content, metadata, source) => {
    if (!draftKey) return
    // Nothing worth saving — clear any stale draft and bail
    const hasContent = content.trim().length > 0
    const hasMetadata = !!(metadata?.title || metadata?.summary || metadata?.image || metadata?.tagsRaw)
    const hasSource = !!(source?.name || source?.url)
    if (!hasContent && !hasMetadata && !hasSource) {
      clearTimeout(timerRef.current)
      try { localStorage.removeItem(draftKey) } catch {}
      return
    }
    // Debounce — only write after typing has paused for DEBOUNCE_MS
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      try {
        const draft = { content, metadata, source, savedAt: Date.now() }
        localStorage.setItem(draftKey, JSON.stringify(draft))
      } catch {
        // localStorage unavailable or full — fail silently
      }
    }, DEBOUNCE_MS)
  }, [draftKey])

  const loadDraft = useCallback(() => {
    if (!draftKey) return null
    try {
      const raw = localStorage.getItem(draftKey)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }, [draftKey])

  const clearDraft = useCallback(() => {
    if (!draftKey) return
    clearTimeout(timerRef.current)
    try {
      localStorage.removeItem(draftKey)
    } catch {
      // fail silently
    }
  }, [draftKey])

  return { saveDraft, loadDraft, clearDraft }
}

// Formats a savedAt timestamp into a human-readable relative string
export function formatDraftAge(savedAt) {
  const diff = Date.now() - savedAt
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${days} day${days === 1 ? '' : 's'} ago`
}
