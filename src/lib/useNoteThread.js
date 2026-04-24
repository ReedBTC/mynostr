/**
 * useNoteThread — fetches the full thread context around a focused kind 1
 * note and returns structured data ready for rendering.
 *
 * Flow:
 *   1. Determine rootId — parseReplyRefs on the focus note. If it has no
 *      reply refs, it IS the root.
 *   2. Primal `thread_view` by rootId returns the root event + every
 *      descendant + profiles in one round trip.
 *   3. If Primal gave us nothing, fall back to NDK: fetch by ids: [rootId]
 *      for the root, and #e: [rootId] for descendants.
 *   4. Build a pubkey→profile map, a parentId→children map, and walk the
 *      ancestor chain from focus up to root (inclusive).
 *
 * Session-level cache keyed by rootId so backing out of a thread and
 * re-entering is instant and doesn't refetch.
 *
 * Returns:
 *   {
 *     loading: boolean,
 *     error: string | null,
 *     root: note | null,
 *     focus: note,                 // the clicked note (may equal root)
 *     ancestors: note[],           // root → parent-of-focus (inclusive of root, exclusive of focus)
 *     childrenByParent: Map<id, note[]>,   // for recursive descendant tree
 *     profiles: Map<pubkey, profile>,
 *   }
 */
import { useEffect, useState } from 'react'
import { fetchThread, fetchNotesByIds, fetchProfiles } from './primal.js'
import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'
import { parseReplyRefs } from './nip10.js'

// Session-scoped cache. Keyed by rootId so every note in the same thread
// shares one cached fetch.
const threadCache = new Map() // rootId → { notesById, profiles }

function buildChildrenMap(notes) {
  const children = new Map()
  for (const n of notes) {
    const { parentId } = parseReplyRefs(n)
    if (!parentId) continue
    if (!children.has(parentId)) children.set(parentId, [])
    children.get(parentId).push(n)
  }
  // Sort each child list newest-first so the freshest replies sit closest
  // to their parent.
  for (const list of children.values()) {
    list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
  }
  return children
}

function walkAncestors(focus, notesById) {
  // Ascend via parent refs until we hit something with no parentId, or
  // hit an id we've already visited (malformed self-ref safety), or fall
  // off the cache. Returns [root, ..., parentOfFocus].
  const chain = []
  const seen = new Set([focus.id])
  let current = focus
  while (true) {
    const { parentId } = parseReplyRefs(current)
    if (!parentId || seen.has(parentId)) break
    seen.add(parentId)
    const next = notesById.get(parentId)
    if (!next) break
    chain.push(next)
    current = next
  }
  return chain.reverse()
}

export function useNoteThread(focus) {
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    if (!focus?.id) {
      setState({ loading: false, error: null, data: null })
      return
    }
    let cancelled = false

    const { rootId: focusRootId } = parseReplyRefs(focus)
    const rootId = focusRootId || focus.id

    const cached = threadCache.get(rootId)
    if (cached) {
      const notesById = cached.notesById
      const ancestors = walkAncestors(focus, notesById)
      const root = notesById.get(rootId) || ancestors[0] || focus
      const childrenByParent = buildChildrenMap(Array.from(notesById.values()))
      setState({ loading: false, error: null, data: {
        root, focus, ancestors, childrenByParent, profiles: cached.profiles,
      }})
      return
    }

    setState({ loading: true, error: null, data: null })

    ;(async () => {
      try {
        // Primary: Primal thread_view — one call, pre-indexed.
        const primal = await fetchThread(rootId)
        let notes    = [...primal.notes]
        let profiles = new Map(primal.profiles)

        // The fetched set must at least contain the focus note; if Primal
        // didn't cough up anything useful, fall back to NDK.
        const seedMissing = !notes.some(n => n.id === focus.id)
        if (seedMissing || notes.length === 0) {
          try {
            const ndk = getNDK()
            await connectAndWait(ndk, 3000).catch(() => {})
            // Root + any descendants indexed via #e.
            const [rootSet, descSet] = await Promise.all([
              withTimeout(ndk.fetchEvents({ ids: [rootId] }),                    4000).catch(() => new Set()),
              withTimeout(ndk.fetchEvents({ kinds: [1], '#e': [rootId] }),      4000).catch(() => new Set()),
            ])
            const byId = new Map(notes.map(n => [n.id, n]))
            for (const ev of rootSet) if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev)
            for (const ev of descSet) if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev)
            // Always include the focus itself — it's definitely kind 1.
            if (!byId.has(focus.id)) byId.set(focus.id, focus)
            notes = Array.from(byId.values())
          } catch {}
        }

        // Dedup and ensure focus is in the set (it might have been the
        // seed from a feed that Primal's thread_view missed).
        const notesById = new Map()
        for (const n of notes) if (n?.id) notesById.set(n.id, n)
        if (!notesById.has(focus.id)) notesById.set(focus.id, focus)

        // Backfill any missing author profiles.
        const missing = new Set()
        for (const n of notesById.values()) if (!profiles.has(n.pubkey)) missing.add(n.pubkey)
        if (missing.size) {
          try {
            const fetched = await fetchProfiles([...missing])
            for (const [pk, p] of fetched) profiles.set(pk, p)
          } catch {}
        }

        // Cap cache growth — 30 threads is plenty for a session.
        if (threadCache.size >= 30) {
          const firstKey = threadCache.keys().next().value
          threadCache.delete(firstKey)
        }
        threadCache.set(rootId, { notesById, profiles })

        if (cancelled) return
        const ancestors = walkAncestors(focus, notesById)
        const root = notesById.get(rootId) || ancestors[0] || focus
        const childrenByParent = buildChildrenMap(Array.from(notesById.values()))
        setState({ loading: false, error: null, data: {
          root, focus, ancestors, childrenByParent, profiles,
        }})
      } catch (e) {
        if (cancelled) return
        setState({ loading: false, error: e?.message || 'Failed to load thread', data: null })
      }
    })()

    return () => { cancelled = true }
  }, [focus?.id])

  return state
}

// Ancestor walker that can also be called standalone if a caller needs
// just the chain (e.g., for scroll-to-focus logic). Exposed for tests.
export { walkAncestors, buildChildrenMap }
