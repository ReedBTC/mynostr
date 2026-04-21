/**
 * publishProfile.js — Sign and publish a Kind 0 profile event.
 *
 * Kind 0 is replaceable and un-tagged: relays keep only the newest event per
 * author, and publishing overwrites ALL fields. So before emitting a new
 * event we re-fetch the current kind 0 from relays and merge the user's
 * edits on top — any non-standard fields the owner set in another client
 * (bot, zapService, custom, etc.) survive.
 */
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, FALLBACK_RELAYS, signWithTimeout, publishToOwnOutbox } from './ndk.js'

// Per-field length caps. These match the UI's maxLength on ProfileEditor
// inputs but are enforced here too so any caller (scripts, future forms)
// can't publish unbounded kind 0 content. Nostr relays silently reject or
// truncate very large events; keeping fields short keeps profiles portable.
export const PROFILE_FIELD_CAPS = {
  display_name: 80,
  name:         40,
  about:        1000,
  picture:      1500,
  banner:       1500,
  website:      1500,
  nip05:        120,
  lud16:        120,
}

/**
 * @param {object} params
 * @param {string} params.pubkey — signed-in user's hex pubkey
 * @param {object} params.edits — fields to overlay, keyed with NIP-01
 *   snake_case names (name, display_name, about, picture, banner, nip05,
 *   lud16, website). Empty string means "clear this field."
 * @returns {Promise<{profileContent: object, relays: string[]}>}
 */
export async function publishProfile({ pubkey, edits }) {
  const ndk = getNDK()

  // Fetch the newest kind 0 so we preserve any fields the UI doesn't edit.
  // If nothing comes back (first-time profile) we start from an empty object.
  let baseContent = {}
  try {
    const existing = await ndk.fetchEvent({ kinds: [0], authors: [pubkey] })
    if (existing?.content) {
      try { baseContent = JSON.parse(existing.content) || {} } catch {}
    }
  } catch {
    // Relay fetch failed — still let the user publish rather than block.
  }

  const merged = { ...baseContent }
  for (const [k, v] of Object.entries(edits || {})) {
    if (v === '' || v === null || v === undefined) {
      delete merged[k]           // empty string clears the field
    } else {
      // Defensive cap even if the UI's maxLength was bypassed (pasted value,
      // alternative caller, stale page). Slice by code point via the
      // iterator so an emoji or surrogate pair at the boundary isn't cut
      // in half — String.prototype.slice counts UTF-16 units.
      const cap = PROFILE_FIELD_CAPS[k]
      if (cap && typeof v === 'string' && [...v].length > cap) {
        merged[k] = [...v].slice(0, cap).join('')
      } else {
        merged[k] = v
      }
    }
  }

  const event = new NDKEvent(ndk)
  event.kind = 0
  event.content = JSON.stringify(merged)
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = []                // kind 0 carries no tags in the common case

  // Publish to the user's write relays if we know them, fall back otherwise.
  // Track whether we actually reached the relay list so the UI can warn the
  // user when their kind 0 only landed on generic relays.
  let relayUrls = FALLBACK_RELAYS
  let usedFallbackRelays = true
  try {
    const relayList = await ndk.activeUser?.relayList()
    const writeRelays = relayList?.writeRelayUrls
    if (writeRelays?.length) {
      relayUrls = writeRelays
      usedFallbackRelays = false
    }
  } catch {}

  await signWithTimeout(event)
  // Kind 0 is replaceable and keyed only by author, so any copy on a relay
  // outside the user's write set becomes unreachable the next time they edit
  // their profile. Publish to their own outbox only so every copy stays
  // editable later.
  const publishedTo = await publishToOwnOutbox(event)
  const confirmedRelays = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  const relays = confirmedRelays.length ? confirmedRelays : relayUrls

  return { profileContent: merged, relays, usedFallbackRelays }
}
