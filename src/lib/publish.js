import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, FALLBACK_RELAYS } from './ndk.js'
import { titleToSlug, toUnixTimestamp, parseDateString, buildAttributionLine } from './utils.js'

/**
 * Constructs and publishes a NIP-23 Kind 30023 event.
 *
 * @param {object} params
 * @param {string} params.content - Raw markdown content from the editor
 * @param {object} params.metadata - Title, summary, publishedAtDate, image, tags
 * @param {object} params.source - name and url for the "originally published at" attribution
 * @returns {Promise<{nevent: string, relays: string[]}>}
 */
export async function publishArticle({ content, metadata, source }) {
  const ndk = getNDK()

  // Prepend attribution line if source name is provided
  let finalContent = content
  if (source.name) {
    const publishedAtUnix = metadata.publishedAtDate
      ? toUnixTimestamp(parseDateString(metadata.publishedAtDate))
      : null
    const attribution = buildAttributionLine(source.name, source.url, publishedAtUnix)
    finalContent = attribution + content
  }

  const createdAt = Math.floor(Date.now() / 1000)

  // published_at: use the user-supplied date if set, otherwise fall back to createdAt
  const publishedAt = metadata.publishedAtDate
    ? String(toUnixTimestamp(parseDateString(metadata.publishedAtDate)))
    : String(createdAt)

  // Build tags array
  const tags = [
    ['d', titleToSlug(metadata.title)],
    ['title', metadata.title],
    ['published_at', publishedAt],
    ['client', 'nostrmd'],
  ]
  if (metadata.summary) tags.push(['summary', metadata.summary])
  if (metadata.image) tags.push(['image', metadata.image])
  metadata.tags?.forEach(t => { if (t) tags.push(['t', t]) })

  // Construct the NDK event
  const event = new NDKEvent(ndk)
  event.kind = 30023
  event.content = finalContent
  event.created_at = createdAt
  event.tags = tags

  // Determine relay set — try to use the user's Kind 10002 relay list via NDK,
  // fall back to hardcoded defaults if NDK hasn't loaded one
  let relayUrls = FALLBACK_RELAYS
  try {
    const relayList = await ndk.activeUser?.relayList()
    const writeRelays = relayList?.writeRelayUrls
    if (writeRelays?.length) relayUrls = writeRelays
  } catch {
    // Non-fatal — fallback relays will be used
  }

  // Sign and publish — NDK returns a Set of relays that acknowledged the event
  await event.sign()
  const publishedTo = await event.publish()
  const confirmedRelays = Array.from(publishedTo).map(r => r.url).filter(Boolean)

  // Fall back to the attempted relay list if NDK returns nothing
  const relays = confirmedRelays.length ? confirmedRelays : relayUrls

  // nevent for the njump.me link
  const nevent = nip19.neventEncode({
    id: event.id,
    relays: relays.slice(0, 3),
    author: event.pubkey,
  })

  // naddr is the correct permanent reference for a replaceable Kind 30023 event —
  // it resolves to the latest version via kind + pubkey + d-tag
  const naddr = nip19.naddrEncode({
    kind: 30023,
    pubkey: event.pubkey,
    identifier: titleToSlug(metadata.title),
    relays: relays.slice(0, 3),
  })

  return { nevent, naddr, relays }
}
