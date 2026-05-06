/**
 * Shared NIP-25 like publisher.
 *
 * Builds a kind 7 reaction event referencing the target, signs it with
 * the active NDK signer, publishes to the user's outbox, and updates the
 * session-wide reaction store optimistically with rollback on failure.
 *
 * Used by every "Like" button across modules so the rules — e/a/p/k tag
 * combinations, optimistic mark, zero-ack rollback — live in one place.
 *
 * @param {object} target
 * @param {string} target.eventId      Hex event id of the kind 1 / replaceable's latest event.
 * @param {string} target.eventPubkey  Author pubkey (hex). Required for the p-tag.
 * @param {number|string} target.kind  Kind being liked (1, 30023, 30402, 31922, 31923, etc.).
 * @param {string} [target.addressable]  "<kind>:<pubkey>:<dtag>" coord for replaceables.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 *   ok=true on at least one relay ack. ok=false on signing error or zero-ack publish;
 *   the store rollback has already happened in either case.
 */

import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToPool } from './ndk.js'
import { markLiked, unmarkLiked } from './myReactionStore.js'

export async function publishLike(target) {
  const { eventId, eventPubkey, kind, addressable } = target || {}

  // Validate FIRST so invalid input doesn't trigger an optimistic-mark
  // flicker. The mark only fires once we know the publish has a chance.
  if (!eventPubkey || !/^[0-9a-f]{64}$/i.test(eventPubkey)) {
    return { ok: false, error: 'Invalid recipient pubkey' }
  }

  // Optimistic mark BEFORE awaiting the signer so the heart flips
  // immediately. Rolled back if signing/publish fails or zero relays ack.
  markLiked({ eventId, addressable })

  try {
    const ndk = getNDK()
    const ev = new NDKEvent(ndk)
    ev.kind = 7
    ev.content = '+'
    const tags = [['p', eventPubkey]]
    if (eventId && /^[0-9a-f]{64}$/i.test(eventId)) tags.push(['e', eventId])
    if (addressable && typeof addressable === 'string' && addressable.includes(':')) {
      tags.push(['a', addressable])
    }
    if (kind != null) tags.push(['k', String(kind)])
    tags.push(['client', 'mynostr'])
    ev.tags = tags

    await signWithTimeout(ev)
    const publishedTo = await publishToPool(ev)
    if (!publishedTo || publishedTo.size === 0) {
      unmarkLiked({ eventId, addressable })
      return { ok: false, error: 'no relays accepted the like' }
    }
    return { ok: true }
  } catch (err) {
    unmarkLiked({ eventId, addressable })
    if (import.meta.env.DEV) console.warn('[mynostr-likes] publishLike failed', err?.message || err)
    return { ok: false, error: err?.message || String(err) }
  }
}
