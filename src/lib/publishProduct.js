/**
 * Publish a marketplace listing — kind 30402, NIP-99 + Gamma extension.
 *
 * Flow mirrors publishArticle (publish.js):
 *   1. Encode the form via gamma.encodeProduct → { kind, content, tags }
 *   2. Hand to NDK as an NDKEvent, sign with timeout
 *   3. Publish via outbox-aware helper (replaceable kind, must reach
 *      author's own write relays so future edits/deletes can find it)
 *   4. Return naddr for sharing + the relay set we confirmed
 *
 * The composer's input is the same form shape gamma.decodeProduct
 * produces, so edit-existing-listing → modify form → re-publish round-
 * trips through the same `dTag` and looks like an in-place edit to
 * relays / readers.
 */

import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, signWithTimeout, FALLBACK_RELAYS, publishToOwnOutbox } from './ndk.js'
import { encodeProduct, KIND_PRODUCT } from './gamma.js'

/**
 * @param {object} form — gamma.encodeProduct-shaped form (see gamma.js docs)
 * @returns {Promise<{naddr: string, relays: string[]}>}
 *
 * Throws on encode failure (missing required fields) or sign timeout.
 */
export async function publishProduct(form) {
  const ndk = getNDK()
  const { kind, content, tags } = encodeProduct(form)

  // Stamp `client` so other clients can attribute. Mirrors publishArticle.
  const finalTags = tags.concat([['client', 'mynostr']])

  const event = new NDKEvent(ndk)
  event.kind = kind
  event.content = content
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = finalTags

  // Pull the user's write relays for the naddr hint. Falls through to
  // hardcoded defaults if the kind 10002 isn't loaded.
  let hintRelays = FALLBACK_RELAYS
  try {
    const relayList = await ndk.activeUser?.relayList()
    const writeRelays = relayList?.writeRelayUrls
    if (writeRelays?.length) hintRelays = writeRelays
  } catch {}

  await signWithTimeout(event)
  // Kind 30402 is replaceable by `d` tag. publishToOwnOutbox guarantees
  // the user's own write relays receive the event so future edits/deletes
  // can target the same set.
  const publishedTo = await publishToOwnOutbox(event)
  const confirmedRelays = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  const relays = confirmedRelays.length ? confirmedRelays : hintRelays

  const naddr = nip19.naddrEncode({
    kind: KIND_PRODUCT,
    pubkey: event.pubkey,
    identifier: form.dTag,
    relays: relays.slice(0, 3),
  })

  return { naddr, relays }
}

/**
 * Mark a listing as sold without unpublishing — re-emit the same dTag
 * with status=sold (and visibility=hidden if requested). Used by the
 * "mark as sold" action on My Selling cards.
 */
export async function markProductSold(form, { hide = false } = {}) {
  return publishProduct({ ...form, status: 'sold', visibility: hide ? 'hidden' : form.visibility })
}
