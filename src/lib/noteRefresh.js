/**
 * noteRefresh — manual "fetch fresh comments + zaps for this note from
 * my read relays" plumbing for the per-note three-dot menu.
 *
 * Why it exists: the default fetch paths read from NDK's connected
 * pool, which holds (FALLBACK_RELAYS ∪ user's NIP-65 write relays). It
 * does NOT include the user's READ-ONLY relays — those never get
 * connected because nothing else in the app writes to them. The result
 * is a blind spot: comments / zaps that landed only on a user's
 * read-only relay aren't visible until someone else's client mirrors
 * them onto a relay we already poll.
 *
 * The refresh path closes the gap by querying an explicit relay set
 * built from the user's full read surface (read-only + read+write
 * NIP-65 entries), then priming the in-memory caches that
 * useCommentCount + ZapMessagesSection read from. After priming, an
 * `emit` notifies any subscribed hooks for that note id so they
 * re-render without waiting for their TTLs to expire.
 *
 * The whole flow is bypass-Primal-by-design — Primal's index lags
 * brand-new events by tens of seconds and can permanently miss zaps
 * that only landed on relays Primal doesn't crawl. "Refresh" should
 * mean "ask my relays directly, right now."
 */

import { useEffect, useState } from 'react'
import { NDKRelaySet } from '@nostr-dev-kit/ndk'
import { getNDK, connectAndWait, getOwnReadRelays } from './ndk.js'
import { withTimeout } from './utils.js'
import { primeCommentCount } from './useCommentCount.js'
import { primeZapMessages } from './zapMessages.js'

const REPLY_LIMIT  = 200
const ZAP_LIMIT    = 200
const FETCH_TIMEOUT_MS = 6000

// noteId → Set<callback>. Hooks that care about a particular note
// register a callback here and bump their internal state when called,
// causing the consuming React component to re-read from the now-primed
// caches.
const subscribers = new Map()

function notify(noteId) {
  const set = subscribers.get(noteId)
  if (!set) return
  // Iterate a snapshot — listeners may unsubscribe inside the callback,
  // and mutating the live set during iteration would skip entries.
  for (const fn of [...set]) {
    try { fn() } catch {}
  }
}

/**
 * Subscribe to refresh signals for a single note. Called by hooks
 * inside useCommentCount and ZapMessagesSection. Returns the cleanup
 * function the caller should run on unmount / dep change.
 */
function subscribe(noteId, fn) {
  if (!noteId) return () => {}
  let set = subscribers.get(noteId)
  if (!set) { set = new Set(); subscribers.set(noteId, set) }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) subscribers.delete(noteId)
  }
}

/**
 * React hook — returns a counter that increments every time
 * refreshNoteData fires for this note. Adding it to a useEffect's
 * deps array is the standard re-fetch trigger.
 */
export function useNoteRefreshKey(noteId) {
  const [key, setKey] = useState(0)
  useEffect(() => {
    if (!noteId) return
    return subscribe(noteId, () => setKey(k => k + 1))
  }, [noteId])
  return key
}

/**
 * Force-fetch comments + zaps for a single note from the user's
 * NIP-65 read relays (or fall back to NDK's pool when no kind 10002
 * is readable — same fallback profile as publishToOwnOutbox), prime
 * the consumer caches with the results, and notify subscribers.
 *
 * Returns { commentCount, zapCount, relayCount } so the caller (the
 * three-dot menu) can show a brief success message. Throws on a hard
 * NDK / relay-set error; partial results (some relays time out) are
 * not errors — we return whatever made it.
 */
export async function refreshNoteData(noteId) {
  if (!noteId) throw new Error('refreshNoteData: noteId required')

  const ndk = getNDK()
  await connectAndWait(ndk, 3000).catch(() => {})

  // Build explicit relay set from the user's NIP-65 read relays.
  // Include read-only relays specifically — those aren't in NDK's
  // explicit pool and would otherwise be invisible to the fetch.
  const readRelays = await getOwnReadRelays(ndk).catch(() => null)
  const relaySet = readRelays?.length
    ? NDKRelaySet.fromRelayUrls(readRelays, ndk)
    : undefined

  // Parallel: kind-1 replies (#e) + kind-9735 zap receipts (#e).
  // Each side handles its own timeout / empty result; one slow side
  // doesn't block the other from priming.
  const [replies, zaps] = await Promise.all([
    withTimeout(
      ndk.fetchEvents(
        { kinds: [1], '#e': [noteId], limit: REPLY_LIMIT },
        { closeOnEose: true },
        relaySet,
      ),
      FETCH_TIMEOUT_MS,
    ).catch(() => new Set()),
    withTimeout(
      ndk.fetchEvents(
        { kinds: [9735], '#e': [noteId], limit: ZAP_LIMIT },
        { closeOnEose: true },
        relaySet,
      ),
      FETCH_TIMEOUT_MS,
    ).catch(() => new Set()),
  ])

  const replyArr = Array.from(replies)
  const zapArr   = Array.from(zaps)

  primeCommentCount(noteId, null, replyArr.length)
  primeZapMessages(noteId, zapArr)

  notify(noteId)

  return {
    commentCount: replyArr.length,
    zapCount: zapArr.length,
    relayCount: readRelays?.length ?? 0,
  }
}
