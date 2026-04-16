/**
 * publishNote.js — Sign and publish a Kind 1 short note event.
 * Follows the same relay resolution pattern as publish.js.
 */
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, FALLBACK_RELAYS } from './ndk.js'

/**
 * Sign and publish a Kind 1 note.
 *
 * @param {object} params
 * @param {string} params.content — note text
 * @param {Array<string[]>} params.tags — final merged tag array
 * @returns {Promise<{nevent: string, noteId: string, relays: string[]}>}
 */
export async function publishNote({ content, tags }) {
  const ndk = getNDK()

  const event = new NDKEvent(ndk)
  event.kind = 1
  event.content = content
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = tags

  // Resolve relay set
  let relayUrls = FALLBACK_RELAYS
  try {
    const relayList = await ndk.activeUser?.relayList()
    const writeRelays = relayList?.writeRelayUrls
    if (writeRelays?.length) relayUrls = writeRelays
  } catch {
    // Non-fatal — fallback relays will be used
  }

  await event.sign()
  const publishedTo = await event.publish()
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
