/**
 * BookmarksTab — paginated feed of a user's public kind 10003 bookmarks.
 *
 * Flow:
 *   1. Fetch the single replaceable kind 10003 event for the viewed user.
 *      Try Primal first (fast, via fetchProfiles-style user-infos isn't
 *      appropriate — use NDK directly for this one event).
 *   2. Extract `e`-tags → array of note ids. Order is whatever the client
 *      that wrote the list produced; we honor it so users see their list
 *      the way their primary client shows it.
 *   3. Paginate: slice the id array into windows of pageSize and call
 *      fetchNotesByIds for each window. Hydrate author profiles per page.
 *
 * Encrypted/private bookmarks live in the event's `content` field (NIP-04
 * payload) — we intentionally skip that: this app doesn't yet carry the
 * decrypt flow, and users would be surprised by "logged-in encrypted
 * bookmarks suddenly visible."
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotesByIds, fetchProfiles } from '../../../../lib/primal.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { useInfiniteFeed } from '../../../../hooks/useInfiniteFeed.js'
import NotesFeed from './NotesFeed.jsx'

const BOOKMARK_KIND = 10003

async function loadBookmarkIds(pubkey) {
  const ndk = getNDK()
  await connectAndWait(ndk, 3000).catch(() => {})
  const event = await Promise.race([
    ndk.fetchEvent({ kinds: [BOOKMARK_KIND], authors: [pubkey] }),
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
  ]).catch(() => null)
  if (!event) return []
  const ids = []
  const seen = new Set()
  for (const t of event.tags || []) {
    if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
      const id = t[1].toLowerCase()
      if (!seen.has(id)) { seen.add(id); ids.push(id) }
    }
  }
  // Kind 10003 has no per-item timestamp; clients almost universally
  // *append* new bookmarks, so the tail of the tag array is the most
  // recently added. Reverse so the feed leads with "just bookmarked."
  ids.reverse()
  return ids
}

export default function BookmarksTab({ user, isOwner }) {
  const pubkey = user?.pubkey
  const displayName = user?.profile?.displayName || user?.profile?.name || 'this user'

  // Bookmark id array lives outside useInfiniteFeed — it's fetched once per
  // viewed user, then the hook paginates through the slice.
  const [ids, setIds] = useState([])
  const [idsLoading, setIdsLoading] = useState(false)
  const [idsError, setIdsError] = useState(null)
  const idsCursorRef = useRef(0)

  useEffect(() => {
    idsCursorRef.current = 0
    setIds([])
    setIdsError(null)
    if (!pubkey) return
    let cancelled = false
    setIdsLoading(true)
    ;(async () => {
      try {
        const list = await loadBookmarkIds(pubkey)
        if (cancelled) return
        setIds(list)
      } catch (e) {
        if (cancelled) return
        setIdsError(e?.message || 'Failed to load bookmarks')
      } finally {
        if (!cancelled) setIdsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  const loadPage = useCallback(async ({ limit }) => {
    const start = idsCursorRef.current
    const slice = ids.slice(start, start + limit)
    if (slice.length === 0) return { items: [], done: true }
    idsCursorRef.current = start + slice.length

    const { notes, profiles } = await fetchNotesByIds(slice)
    // Preserve the bookmark list order so the UI matches what users see in
    // their primary client. Primal returns unsorted; sort by slice index.
    const indexOf = new Map(slice.map((id, i) => [id, i]))
    notes.sort((a, b) => (indexOf.get(a.id) ?? 1e9) - (indexOf.get(b.id) ?? 1e9))

    // Backfill missing author profiles in one batch.
    const missing = new Set()
    for (const n of notes) if (!profiles.has(n.pubkey)) missing.add(n.pubkey)
    if (missing.size) {
      try {
        const fetched = await fetchProfiles([...missing])
        for (const [pk, p] of fetched) profiles.set(pk, p)
      } catch {}
    }

    return {
      items: notes,
      profiles,
      done: idsCursorRef.current >= ids.length,
    }
  }, [ids])

  // Key change → useInfiniteFeed resets and calls page 1. We key on the
  // bookmark-id array identity so the hook resets once `ids` is loaded.
  const key = useMemo(() => `bookmarks:${pubkey || ''}:${ids.length}`, [pubkey, ids.length])

  const feed = useInfiniteFeed({
    key,
    loadPage,
    pageSize: 20,
    enabled: !!pubkey && !idsLoading && ids.length > 0,
  })

  const emptyMessage = isOwner
    ? 'You haven\u2019t bookmarked any notes yet.'
    : `${displayName} hasn\u2019t bookmarked any public notes.`

  // While we wait for the kind 10003 event, show the same spinner the feed
  // uses for page 1 so there's no flash of "no bookmarks."
  if (!pubkey) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">No user loaded.</p>
        </div>
      </div>
    )
  }

  if (idsLoading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-neutral-500 mt-2">Loading bookmarks…</p>
        </div>
      </div>
    )
  }

  if (idsError) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-red-400">{idsError}</p>
        </div>
      </div>
    )
  }

  if (ids.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">{emptyMessage}</p>
        </div>
      </div>
    )
  }

  return (
    <NotesFeed
      items={feed.items}
      profiles={feed.profiles}
      loading={feed.loading}
      initialLoading={feed.initialLoading}
      error={feed.error}
      done={feed.done}
      sentinelRef={feed.sentinelRef}
      emptyMessage={emptyMessage}
      onReload={feed.reload}
    />
  )
}
