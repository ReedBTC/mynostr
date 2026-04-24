/**
 * useUserReactions — tracks which notes the current session user has
 * already "liked" (NIP-25 kind 7) so the heart icon survives card
 * unmount/remount (scroll away → scroll back) and full reloads.
 *
 * Design:
 *   - One-time fetch on session login: kind 7 events authored by the
 *     user, capped at `limit` so users with tens of thousands of
 *     reactions don't stall page load. Older likes beyond the cap won't
 *     round-trip as "Liked" state — acceptable trade for bounded cost.
 *   - Returns `{ likedIds, markLiked, unmarkLiked, isLoaded }`. Consumers
 *     derive `liked = likedIds.has(id)` rather than holding local state,
 *     so a second card showing the same note stays in sync.
 *   - Optimistic flow in NoteActionBar: markLiked BEFORE awaiting the
 *     signer; unmarkLiked if publish throws. Relays dedup duplicate
 *     kind 7s so the cap-miss worst case is just a harmless re-publish.
 *
 * NIP-25: content '-' is an explicit dislike; anything else ('+', '❤️',
 * '🔥', empty) counts as a positive reaction. We mirror that here so
 * likes issued from other clients still register.
 */
import { useState, useEffect, useCallback } from 'react'
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'

const LIKE_FETCH_LIMIT = 500

export function useUserReactions(user) {
  const [likedIds, setLikedIds] = useState(() => new Set())
  const [isLoaded, setIsLoaded] = useState(false)

  const pubkey = user?.pubkey

  useEffect(() => {
    if (!pubkey) {
      setLikedIds(new Set())
      setIsLoaded(true)
      return
    }
    setIsLoaded(false)
    let cancelled = false
    ;(async () => {
      try {
        const ndk = getNDK()
        const events = await withTimeout(
          ndk.fetchEvents({ kinds: [7], authors: [pubkey], limit: LIKE_FETCH_LIMIT }),
          6000,
        )
        if (cancelled) return
        const ids = new Set()
        for (const ev of events) {
          if (ev.content === '-') continue  // explicit dislike — skip
          // NIP-25: the target note is the LAST `e` tag (or only one).
          // Some clients include multiple e-tags for thread context; the
          // last is canonical per the spec.
          const eTags = (ev.tags || []).filter(t => t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || ''))
          const target = eTags[eTags.length - 1]
          if (target) ids.add(target[1].toLowerCase())
        }
        if (!cancelled) setLikedIds(ids)
      } catch {
        // Leave set empty — worst case the user can re-like and the
        // relay dedupes.
      } finally {
        if (!cancelled) setIsLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  const markLiked = useCallback((noteId) => {
    if (!noteId) return
    const id = noteId.toLowerCase()
    setLikedIds(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const unmarkLiked = useCallback((noteId) => {
    if (!noteId) return
    const id = noteId.toLowerCase()
    setLikedIds(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  return { likedIds, markLiked, unmarkLiked, isLoaded }
}
