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
 *
 * Advanced relay override:
 *   When `form.relayOverride.enabled` is true and the relays array has
 *   at least one valid wss:// entry, publish goes ONLY to those relays
 *   instead of the outbox. Used for private-group / restricted-relay
 *   listings — readers who don't subscribe to those relays won't see
 *   the listing. Same pattern publishNote uses.
 */

import { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, signWithTimeout, FALLBACK_RELAYS, publishToOwnOutbox } from './ndk.js'
import { sanitizeRelayUrls } from './publishNote.js'
import { encodeProduct, KIND_PRODUCT } from './gamma.js'

/**
 * @param {object} form — gamma.encodeProduct-shaped form (see gamma.js docs)
 * @returns {Promise<{naddr: string, eventId: string, relays: string[]}>}
 *   eventId is the raw 64-char hex id of the just-signed event — used by
 *   external-viewer links (Plebeian's URL takes the raw event id, not naddr).
 *
 * Throws on encode failure (missing required fields) or sign timeout, or
 * when an enabled relay override has no usable wss:// URLs.
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

  // Resolve relay set — prefer explicit override when supplied, else
  // outbox / write-relays / fallbacks. The override path goes through
  // sanitizeRelayUrls so a bad paste in Advanced gets caught here
  // rather than handed to NDK.
  //
  // The "additive supplement" case (publish to popular marketplace
  // relays in addition to outbox) is intentionally NOT here — instead,
  // the composer's Advanced panel suggests adding those relays to the
  // user's kind 10002 list, so they're naturally part of the outbox
  // for every future publish/edit/delete. That keeps NIP-09 deletions
  // reaching the same set the listing was published to.
  const overrideEnabled = !!form.relayOverride?.enabled
  const overrideUrls    = overrideEnabled ? sanitizeRelayUrls(form.relayOverride.relays) : []

  let hintRelays = FALLBACK_RELAYS
  if (overrideEnabled) {
    if (overrideUrls.length === 0) {
      throw new Error('No valid wss:// relay URLs provided in Advanced override.')
    }
    hintRelays = overrideUrls
  } else {
    try {
      const relayList = await ndk.activeUser?.relayList()
      const writeRelays = relayList?.writeRelayUrls
      if (writeRelays?.length) hintRelays = writeRelays
    } catch {}
  }

  await signWithTimeout(event)

  // Override → publish only to the explicit set. Otherwise outbox-aware
  // publish reaches the user's own write relays so future edits/deletes
  // can target the same set.
  let publishedTo
  if (overrideEnabled) {
    const relaySet = NDKRelaySet.fromRelayUrls(overrideUrls, ndk)
    publishedTo = await event.publish(relaySet)
  } else {
    publishedTo = await publishToOwnOutbox(event)
  }
  const confirmedRelays = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  const relays = confirmedRelays.length ? confirmedRelays : hintRelays

  const naddr = nip19.naddrEncode({
    kind: KIND_PRODUCT,
    pubkey: event.pubkey,
    identifier: form.dTag,
    relays: relays.slice(0, 3),
  })

  return { naddr, eventId: event.id, relays }
}

/**
 * Mark a listing as sold without unpublishing — re-emit the same dTag
 * with status=sold (and visibility=hidden if requested). Used by the
 * "mark as sold" action on My Selling cards.
 */
export async function markProductSold(form, { hide = false } = {}) {
  return publishProduct({ ...form, status: 'sold', visibility: hide ? 'hidden' : form.visibility })
}
