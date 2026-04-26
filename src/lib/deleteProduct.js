/**
 * Delete a kind 30402 listing via NIP-09 deletion request.
 *
 * Event shape matches Plebeian Market (`PlebeianApp/market` —
 * src/publish/products.tsx → deleteProduct), so a delete from MyNostr
 * looks identical to a delete from Plebeian on relays:
 *
 *   kind:    5
 *   content: "Product deleted"
 *   tags:    [['a', '30402:<pubkey>:<dTag>']]
 *
 * Note that NIP-09 is advisory — relays may or may not honor the
 * deletion request, and clients that have already cached the event
 * may keep showing it. We optimistically remove from local state on
 * success regardless.
 */

import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'
import { buildProductCoord, KIND_PRODUCT } from './gamma.js'

export async function deleteProduct({ pubkey, dTag }) {
  if (!pubkey || !dTag) throw new Error('deleteProduct: pubkey and dTag required')
  const ndk = getNDK()
  const coord = buildProductCoord(pubkey, dTag)

  const event = new NDKEvent(ndk)
  event.kind = 5
  event.content = 'Product deleted'
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = [['a', coord]]

  await signWithTimeout(event)
  // Outbox-aware publish — the deletion needs to reach the same relays
  // the original 30402 lives on, which (for our own listings) is the
  // user's write set. Other clients querying that set will see the
  // kind 5 alongside the live listing and apply NIP-09 semantics.
  const publishedTo = await publishToOwnOutbox(event)
  return Array.from(publishedTo).map(r => r.url).filter(Boolean)
}

// Re-exported convenience so callers don't need a second import.
export { KIND_PRODUCT }
