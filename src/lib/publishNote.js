/**
 * publishNote.js — Sign and publish a Kind 1 short note event.
 * Follows the same relay resolution pattern as publish.js.
 */
import { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, FALLBACK_RELAYS, signWithTimeout } from './ndk.js'

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
 * @param {object} params
 * @param {string} params.content — note text
 * @param {Array<string[]>} params.tags — final merged tag array
 * @param {string[]|null} [params.relayOverride] — if non-empty, publish
 *        ONLY to these relays (skips the user's relay list). Used by the
 *        Advanced → private-group flow. Invalid URLs are dropped; if
 *        nothing survives sanitization, we throw rather than silently
 *        fall back — the user asked for a private relay, not "anywhere."
 * @returns {Promise<{nevent: string, noteId: string, relays: string[]}>}
 */
export async function publishNote({ content, tags, relayOverride = null }) {
  const ndk = getNDK()

  const event = new NDKEvent(ndk)
  event.kind = 1
  event.content = content
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = tags

  // Resolve relay set
  let relayUrls = FALLBACK_RELAYS
  let explicitRelaySet = null
  if (relayOverride && relayOverride.length) {
    const sanitized = sanitizeRelayUrls(relayOverride)
    if (sanitized.length === 0) {
      throw new Error('No valid wss:// relay URLs provided in Advanced override.')
    }
    relayUrls = sanitized
    explicitRelaySet = NDKRelaySet.fromRelayUrls(sanitized, ndk)
  } else {
    try {
      const relayList = await ndk.activeUser?.relayList()
      const writeRelays = relayList?.writeRelayUrls
      if (writeRelays?.length) relayUrls = writeRelays
    } catch {
      // Non-fatal — fallback relays will be used
    }
  }

  await signWithTimeout(event)
  const publishedTo = explicitRelaySet
    ? await event.publish(explicitRelaySet)
    : await event.publish()
  const confirmedRelays = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  const relays = confirmedRelays.length ? confirmedRelays : relayUrls

  const nevent = nip19.neventEncode({
    id: event.id,
    relays: relays.slice(0, 3),
    author: event.pubkey,
  })

  const noteId = nip19.noteEncode(event.id)

  return { nevent, noteId, relays }
}
