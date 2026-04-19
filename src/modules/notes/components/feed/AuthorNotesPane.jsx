/**
 * AuthorNotesPane — renders a paginated kind 1 feed for a single author.
 *
 * Shared by the "My Notes" tab (author = viewed user) and the "Search" tab
 * after the user picks an author from the dropdown. All the pagination
 * logic lives in useInfiniteFeed; this component is the glue that
 *   1. resets on pubkey change,
 *   2. tries Primal first,
 *   3. falls back to NDK if Primal returned nothing *on page 1* (rare —
 *      brand-new author, or Primal outage).
 *
 * Pagination cursor is the oldest note's created_at (seconds). Primal's
 * `feed` op with `until` returns the next page older than that timestamp.
 */
import { useCallback, useMemo } from 'react'
import { fetchAuthorNotes, fetchAuthorReplies, fetchProfiles } from '../../../../lib/primal.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { useInfiniteFeed } from '../../../../hooks/useInfiniteFeed.js'
import { isReply } from '../../../../lib/nip10.js'
import NotesFeed from './NotesFeed.jsx'

// Keep an NDK subscription open for a fixed window so slower relays have
// time to reply after the fast ones EOSE. Same pattern Longform uses.
function collectFromRelays(ndk, filter, windowMs) {
  let sub = null
  let timer = null
  let resolveFn = null
  const byId = new Map()
  const promise = new Promise(resolve => {
    resolveFn = resolve
    try {
      sub = ndk.subscribe(filter, { closeOnEose: false, groupable: false })
      sub.on('event', ev => { if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev) })
    } catch { resolve([]); return }
    timer = setTimeout(() => {
      try { sub?.stop() } catch {}
      resolve(Array.from(byId.values()))
      resolveFn = null
      timer = null
    }, windowMs)
  })
  function stop() {
    if (timer) { clearTimeout(timer); timer = null }
    try { sub?.stop() } catch {}
    if (resolveFn) { resolveFn(Array.from(byId.values())); resolveFn = null }
  }
  return { promise, stop }
}

export default function AuthorNotesPane({ pubkey, header, emptyMessage, mode = 'notes', onNoteClick }) {
  const loadPage = useCallback(async ({ cursor, limit }) => {
    if (!pubkey) return { items: [], done: true }
    const until = cursor || null

    // Primary: Primal — fast, pre-indexed. `feed` op with notes:'replies'
    // returns only the author's replies; default op returns their originals
    // mixed with replies, so we post-filter client-side below.
    const primal = mode === 'comments'
      ? await fetchAuthorReplies(pubkey, until, limit)
      : await fetchAuthorNotes(pubkey, until, limit)
    let notes = primal.notes
    let profiles = new Map(primal.profiles)

    // Notes mode: Primal's default feed includes the author's replies too.
    // Strip them so the "Notes" toggle only shows originals.
    if (mode === 'notes') {
      notes = notes.filter(n => !isReply(n))
    }

    // Fallback ONLY on the first page (cursor === null) if Primal returned
    // nothing. We don't want to retry NDK on every page — if Primal doesn't
    // have page N, paging harder through NDK is unlikely to help.
    if (!until && notes.length === 0) {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        const sub = collectFromRelays(
          ndk,
          { kinds: [1], authors: [pubkey], limit },
          2500,
        )
        const raw = await sub.promise
        const byId = new Map()
        for (const ev of raw) if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev)
        let ndkNotes = Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at)
        if (mode === 'notes') ndkNotes = ndkNotes.filter(n => !isReply(n))
        else if (mode === 'comments') ndkNotes = ndkNotes.filter(n => isReply(n))
        notes = ndkNotes
      } catch {}
    }

    // Backfill author profile(s) if Primal didn't include them (common when
    // NDK fallback fired, or the author posted from a relay Primal doesn't
    // crawl).
    const missingAuthors = new Set()
    for (const n of notes) if (!profiles.has(n.pubkey)) missingAuthors.add(n.pubkey)
    if (missingAuthors.size) {
      try {
        const fetched = await fetchProfiles([...missingAuthors])
        for (const [pk, p] of fetched) profiles.set(pk, p)
      } catch {}
    }

    const oldest = notes.length ? notes[notes.length - 1] : null
    return {
      items: notes,
      profiles,
      // Cursor tracks the raw fetched page (pre-filter) to keep pagination
      // moving even when `isReply` strips everything on a given page.
      nextCursor: oldest ? oldest.created_at - 1 : (primal.notes.length ? primal.notes[primal.notes.length - 1].created_at - 1 : null),
      // Only stop when an actual page came back empty. Primal's `feed` op
      // bundles kind-0 profile events and kind-10000133 stats in with the
      // kind-1 payload, so a full "limit" response often filters down to
      // fewer notes — treating that as end-of-feed stops the infinite
      // scroll after one or two pages.
      done: primal.notes.length === 0,
    }
  }, [pubkey, mode])

  const key = useMemo(() => `author:${mode}:${pubkey || ''}`, [pubkey, mode])

  const feed = useInfiniteFeed({ key, loadPage, pageSize: 25, enabled: !!pubkey })

  return (
    <NotesFeed
      items={feed.items}
      profiles={feed.profiles}
      loading={feed.loading}
      initialLoading={feed.initialLoading}
      error={feed.error}
      done={feed.done}
      sentinelRef={feed.sentinelRef}
      header={header}
      emptyMessage={emptyMessage || 'No notes from this author yet.'}
      onReload={feed.reload}
      onNoteClick={onNoteClick}
    />
  )
}
