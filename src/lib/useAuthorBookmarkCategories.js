/**
 * useAuthorBookmarkCategories — read-only counterpart to useNoteBookmarks.
 *
 * Fetches kind 10003 + 30003 bookmark events for any pubkey and parses them
 * with the same parser the owner hook uses, so the two produce identical
 * category shapes. No localStorage caching, no mutation helpers — callers
 * cannot addNote/removeNote/etc. on someone else's lists.
 *
 * Returns { categories, loading }.
 *   categories: [{ id, title, items: [{ id, addedAt }], createdAt, readOnly }]
 *   Primary ("Ungrouped", kind 10003) is pinned first; custom 30001/30003
 *   categories follow newest-first. Categories with zero kind-1 items still
 *   render (they may hold longform-only bookmarks); only tombstones — the
 *   empty replaceables used to signal deletion — are dropped.
 */
import { useEffect, useState } from 'react'
import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'
import { parseEventToCategory, NOTE_PRIMARY_CATEGORY_ID } from './useNoteBookmarks.js'

export function useAuthorBookmarkCategories(pubkey) {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!pubkey) {
      setCategories([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setCategories([])

    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        const events = await withTimeout(
          ndk.fetchEvents({ kinds: [10003, 30001, 30003], authors: [pubkey] }),
          6000,
        )
        if (cancelled) return

        // Drop tombstones (delete signals published as an empty replaceable
        // with only a d-tag). Empty-for-kind categories still parse — the
        // viewer sees them as empty chips.
        const parsed = Array.from(events)
          .filter(ev => {
            if (ev.kind !== 30001 && ev.kind !== 30003) return true
            const tags = ev.tags || []
            const onlyDTag = tags.length === 1 && tags[0]?.[0] === 'd'
            return !(onlyDTag && (!ev.content || ev.content === ''))
          })
          .map(parseEventToCategory)
        // Dedup by id, preferring the newest createdAt per id.
        const byId = new Map()
        for (const cat of parsed) {
          const existing = byId.get(cat.id)
          if (!existing || cat.createdAt > existing.createdAt) byId.set(cat.id, cat)
        }
        const result = Array.from(byId.values())
        result.sort((a, b) => {
          if (a.id === NOTE_PRIMARY_CATEGORY_ID) return -1
          if (b.id === NOTE_PRIMARY_CATEGORY_ID) return 1
          return b.createdAt - a.createdAt
        })
        if (cancelled) return
        setCategories(result)
      } catch {
        if (cancelled) return
        setCategories([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  return { categories, loading }
}
