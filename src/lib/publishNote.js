/**
 * publishNote.js — Sign and publish a Kind 1 short note event.
 * Follows the same relay resolution pattern as publish.js.
 */
import { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, FALLBACK_RELAYS, getOwnWriteRelays, signWithTimeout } from './ndk.js'

// Only trust wss://host… URLs. Rejects anything non-TLS-WS so a stray
// "https://..." or cleartext "ws://" paste in Advanced → Relays can't be
// handed to NDK. The Advanced-override flow exists for *private* publishing
// (private group); plaintext ws:// would silently leak the note even though
// the UI labels the field wss-only.
export function sanitizeRelayUrls(urls) {
  if (!Array.isArray(urls)) return []
  const out = []
  for (const raw of urls) {
    if (typeof raw !== 'string') continue
    const u = raw.trim()
    if (!/^wss:\/\/[^\s]+$/i.test(u)) continue
    out.push(u.replace(/\/$/, ''))
  }
  return Array.from(new Set(out))
}

/**
 * Sign and publish a Kind 1 note.
 *
 * Targets an explicit relay set: the user's kind-10002 write relays
 * unioned with the global fallbacks (reach + recall). Without an
 * explicit set, NDK's `event.publish()` only reaches whatever relays
 * happened to finish their WS handshake by publish time — slow relays
 * silently get skipped, so a write-list of 12 might end up with the
 * note on 6. Building NDKRelaySet directly fixes that: NDK opens any
 * missing connections and waits for ACK from each.
 *
 * Returns both `targetedRelays` (what we asked) and `confirmedRelays`
 * (what ACK'd). Composer can show "X of Y relays" so partial-publish
 * states (one relay timed out) are visible instead of silent.
 *
 * @param {object} params
 * @param {string} params.content — note text
 * @param {Array<string[]>} params.tags — final merged tag array
 * @param {string[]|null} [params.relayOverride] — if non-empty, publish
 *        ONLY to these relays (skips the user's relay list). Used by the
 *        Advanced → private-group flow. Invalid URLs are dropped; if
 *        nothing survives sanitization, we throw rather than silently
 *        fall back — the user asked for a private relay, not "anywhere."
 * @returns {Promise<{nevent: string, noteId: string, relays: string[], targetedRelays: string[], confirmedRelays: string[]}>}
 */
export async function publishNote({ content, tags, relayOverride = null }) {
  const ndk = getNDK()

  const event = new NDKEvent(ndk)
  event.kind = 1
  event.content = content
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = tags

  // Resolve target relay set
  let targetRelays
  if (relayOverride && relayOverride.length) {
    const sanitized = sanitizeRelayUrls(relayOverride)
    if (sanitized.length === 0) {
      throw new Error('No valid wss:// relay URLs provided in Advanced override.')
    }
    targetRelays = sanitized
  } else {
    // Reach + recall: user's outbox (so followers using the outbox model
    // find the note via routing) + fallbacks (so non-followers querying
    // common relays find it too). Deduped. Direct fetch via
    // getOwnWriteRelays — `ndk.activeUser.relayList()` was returning
    // stale results during sessions where the user updated their kind
    // 10002 (a known NDK helper-cache issue documented on the helper).
    const writeRelays = await getOwnWriteRelays(ndk).catch(() => null)
    targetRelays = Array.from(new Set([...(writeRelays || []), ...FALLBACK_RELAYS]))
  }

  const relaySet = NDKRelaySet.fromRelayUrls(targetRelays, ndk)

  await signWithTimeout(event)
  const publishedTo = await event.publish(relaySet)
  const confirmedRelays = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  const relays = confirmedRelays.length ? confirmedRelays : targetRelays

  const nevent = nip19.neventEncode({
    id: event.id,
    relays: relays.slice(0, 3),
    author: event.pubkey,
  })

  const noteId = nip19.noteEncode(event.id)

  return {
    nevent,
    noteId,
    relays,
    targetedRelays: targetRelays,
    confirmedRelays,
  }
}
