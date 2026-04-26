/**
 * Marketplace relay defaults.
 *
 * Listings (kind 30402) are scattered across general-purpose Nostr relays
 * but cluster on a handful of marketplace-friendly ones. The user's own
 * relay set rarely overlaps these — they're usually tuned for follows,
 * articles, DMs — so Search needs to query the user's relays *plus* a
 * curated marketplace set to capture the long tail.
 *
 * Selection criteria:
 *   • Plebeian-aligned hosts (relay.plebeian.market, purplerelay.com)
 *     where Gamma-tagged products are most likely to be indexed.
 *   • Broad-coverage indexers (nostr.band / relay.nostr.band, damus,
 *     primal) so non-Gamma stock NIP-99 listings aren't missed.
 *
 * The list is intentionally small (~6 entries). Querying twenty relays
 * for a feed adds latency without proportional coverage, and most
 * listings of any age are mirrored to at least one of these.
 *
 * Subject to revision: confirm against Plebeian's current `defaultRelays`
 * config (their repo's `src/lib/relays.ts` or equivalent) when wiring
 * Search; this list reflects best-known defaults at the time of writing.
 */

export const DEFAULT_MARKETPLACE_RELAYS = Object.freeze([
  'wss://relay.plebeian.market',
  'wss://purplerelay.com',
  'wss://relay.nostr.band',
  'wss://nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol',
])

/**
 * Augment a user's relay set with the marketplace defaults, deduped.
 * Pass the user's read relays as `userRelays` (an array of wss:// URLs).
 * The user's relays come first so any latency wins go to their primary
 * set; marketplace relays fill in the gaps.
 *
 * Returns a fresh array — safe to mutate, doesn't reuse the frozen
 * default list.
 */
export function augmentWithMarketplaceRelays(userRelays = []) {
  const seen = new Set()
  const out  = []
  const push = (url) => {
    const u = String(url || '').trim()
    if (!u) return
    if (seen.has(u)) return
    seen.add(u)
    out.push(u)
  }
  for (const u of userRelays) push(u)
  for (const u of DEFAULT_MARKETPLACE_RELAYS) push(u)
  return out
}
