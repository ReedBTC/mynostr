/**
 * useCommentCount — count of comments / replies on a kind 1 note,
 * long-form article, or calendar event. Renders inside the Comment
 * button on action bars across the app.
 *
 * Filter shape depends on the target type:
 *   - kind 1 thread root  → { kinds: [1],       '#e': [eventId] }
 *   - addressable target  → { kinds: [1, 1111], '#a': [aTag]    }
 *
 * Kind 1 stays kind-1-only — kind 1111 commenting on plain notes isn't
 * a thing in practice, and including it here would slow the fetch with
 * no payoff. Addressable targets pull both because we're straddling
 * the legacy-kind-1-with-a-tag pattern (plektos, etc.) and the modern
 * NIP-22 kind 1111 pattern in the same view, just like CommentsThread.
 *
 * Same caveat as the thread view: the kind-1 filter matches `#e` on
 * any e-tag — including 'mention' markers from quotes/embeds. So a
 * heavily-quoted note can show a count slightly higher than its real
 * reply count. We accept this because (a) the thread view itself uses
 * the same filter, so the count matches what the user will see when
 * they click in, and (b) marker-aware filtering would require fetching
 * every event to inspect tags, defeating the point of a count.
 *
 * Cached at module scope with a 60s TTL so re-renders / scroll-restore
 * don't refetch. Capped at 200 events per call — if a thread has more
 * than that we render "200+" rather than spinning up an unbounded
 * subscription. Adjust upward later if power users complain.
 */
import { useEffect, useState } from 'react'
import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'

const cache = new Map() // key → { count, ts }
const TTL_MS = 60_000
const LIMIT = 200

function keyOf(eventId, aTag) {
  return `${eventId || ''}|${aTag || ''}`
}

export function useCommentCount({ eventId, aTag } = {}) {
  const [count, setCount] = useState(() => {
    const c = cache.get(keyOf(eventId, aTag))
    if (c && Date.now() - c.ts < TTL_MS) return c.count
    return null
  })

  useEffect(() => {
    if (!eventId && !aTag) { setCount(null); return }
    const key = keyOf(eventId, aTag)
    const cached = cache.get(key)
    if (cached && Date.now() - cached.ts < TTL_MS) {
      setCount(cached.count)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        const filter = aTag
          ? { kinds: [1, 1111], '#a': [aTag], limit: LIMIT }
          : { kinds: [1],       '#e': [eventId], limit: LIMIT }
        const set = await withTimeout(ndk.fetchEvents(filter), 4000).catch(() => new Set())
        if (cancelled) return
        const n = set.size
        cache.set(key, { count: n, ts: Date.now() })
        setCount(n)
      } catch {
        if (!cancelled) setCount(null)
      }
    })()
    return () => { cancelled = true }
  }, [eventId, aTag])

  return count
}

/** Format helper: null → '', limit hit → 'N+', otherwise the number. */
export function formatCommentCount(count) {
  if (count == null) return ''
  if (count >= LIMIT) return `${LIMIT}+`
  return String(count)
}
