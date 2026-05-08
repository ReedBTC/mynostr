/**
 * NIP-89 / kind 31989 — recommended-application event.
 *
 * For Gamma marketplaces, the merchant publishes a kind 31989 with
 * `d=30402` (the listing kind) and `a` tags pointing at the kind 31990
 * handlers they want buyers routed through at checkout (Shopstr,
 * Plebeian, etc.). Compliance grader treats absence as info-level —
 * it's an opt-in routing hint, not a checkout requirement.
 *
 * Spec: NIP-89. Example tag from the spec:
 *   ["d", "30402"]
 *   ["a", "31990:<app-pubkey>:<dtag>", "<relay-hint>", "web"]
 *
 * One 31989 covers one kind. To recommend an app for kind 30402
 * specifically, publish ONE 31989 with d=30402; multiple `a` tags
 * inside that event let the seller recommend several apps for the
 * same kind (the spec allows it).
 */
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'

export const KIND_HANDLER_RECOMMENDATION = 31989
export const KIND_HANDLER_INFORMATION    = 31990
export const RECOMMENDATION_DTAG_LISTING = '30402'  // d-tag = the kind being recommended

// Relay hints we publish must be `wss://` schemes — anything else is
// either malformed or potentially adversarial (an attacker-crafted
// naddr could embed an http:// or javascript: URL hoping a downstream
// reader parses it). Defense-in-depth at the publish boundary; matches
// the codebase-wide `isSafeUrl` pattern for http(s) elsewhere.
const WSS_URL_RE = /^wss:\/\//i

export function isValidRelayHint(url) {
  return typeof url === 'string' && WSS_URL_RE.test(url.trim())
}

/**
 * Parse user-supplied app-handler input. Accepts either:
 *   - bech32 naddr1… encoding a kind-31990 event (relay hints preserved)
 *   - raw coord string "31990:<64-hex pubkey>:<dtag>"
 *
 * @returns {{ ok: true, coord: string, relayHint: string } | { ok: false, error: string }}
 */
export function parseAppHandlerInput(input) {
  const trimmed = String(input || '').trim()
  if (!trimmed) return { ok: false, error: 'Empty input' }

  // naddr path — extract coord + first wss-scheme relay hint, if any.
  if (/^naddr1/i.test(trimmed)) {
    try {
      const decoded = nip19.decode(trimmed)
      if (decoded.type !== 'naddr') {
        return { ok: false, error: 'Decoded but not an naddr' }
      }
      if (decoded.data.kind !== KIND_HANDLER_INFORMATION) {
        return { ok: false, error: `naddr must point at kind ${KIND_HANDLER_INFORMATION} (got ${decoded.data.kind})` }
      }
      // Walk the embedded relay-hint list and keep the first wss-scheme
      // entry. nip19 doesn't validate scheme on decode, so a hostile
      // naddr could otherwise inject http://, javascript:, etc. into our
      // published 31989 tag.
      const safeRelay = (decoded.data.relays || []).find(isValidRelayHint) || ''
      return {
        ok: true,
        coord: `${KIND_HANDLER_INFORMATION}:${decoded.data.pubkey}:${decoded.data.identifier}`,
        relayHint: safeRelay,
      }
    } catch (e) {
      return { ok: false, error: `Invalid naddr: ${e?.message || 'decode failed'}` }
    }
  }

  // Raw-coord path. Strict: 64-hex pubkey, non-empty d-tag.
  const m = trimmed.match(/^(\d+):([0-9a-f]{64}):(.+)$/i)
  if (!m) {
    return {
      ok: false,
      error: 'Paste an naddr1… or a "31990:<pubkey>:<dtag>" coord',
    }
  }
  const kind = Number(m[1])
  if (kind !== KIND_HANDLER_INFORMATION) {
    return { ok: false, error: `Coord kind must be ${KIND_HANDLER_INFORMATION} (got ${kind})` }
  }
  return { ok: true, coord: trimmed, relayHint: '' }
}

/**
 * Publish (or re-publish) the seller's kind 31989 recommending app
 * handlers for kind 30402 listings. Replaceable per (kind, pubkey,
 * dtag); each call overwrites the prior recommendation set.
 *
 * @param {object} params
 * @param {Array<{ coord: string, relayHint?: string, platform?: string }>} params.handlers
 *   One or more kind-31990 references. Empty array → caller should
 *   delete via NIP-09 instead (we don't publish an empty 31989 because
 *   relays would just store a no-op event).
 * @returns {Promise<{ eventId: string, relays: string[] }>}
 */
export async function publishCheckoutAppRecommendation({ handlers }) {
  if (!Array.isArray(handlers) || handlers.length === 0) {
    throw new Error('At least one handler required')
  }

  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')

  const tags = [['d', RECOMMENDATION_DTAG_LISTING]]
  for (const h of handlers) {
    if (!h?.coord) continue
    // ['a', coord, relayHint, platform] — relay hint and platform are
    // both spec-allowed to be empty, but populating platform=web by
    // default keeps the tag round-trippable through clients that
    // expect a 4-element tag. Reject any non-wss relay hint at the
    // publish boundary even if a caller bypassed parseAppHandlerInput's
    // earlier check.
    const safeHint = isValidRelayHint(h.relayHint) ? h.relayHint.trim() : ''
    tags.push([
      'a',
      h.coord,
      safeHint,
      h.platform || 'web',
    ])
  }
  // Stamp `client` so other clients can attribute. Mirrors publishProduct.
  tags.push(['client', 'mynostr'])

  const event = new NDKEvent(ndk)
  event.kind = KIND_HANDLER_RECOMMENDATION
  event.content = ''
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = tags

  await signWithTimeout(event)
  const publishedTo = await publishToOwnOutbox(event)
  const relays = Array.from(publishedTo).map(r => r.url).filter(Boolean)

  return { eventId: event.id, relays }
}

/**
 * Fetch the seller's current kind 31989 for d=30402, decoded into the
 * shape the editor consumes. Returns null when the seller hasn't
 * published one (or the relays didn't return it).
 *
 * @param {string} pubkey
 * @returns {Promise<{ event: object, handlers: Array<{coord: string, relayHint: string, platform: string}> } | null>}
 */
export async function fetchCheckoutAppRecommendation(pubkey) {
  if (!pubkey) return null
  const ndk = getNDK()
  try {
    const ev = await ndk.fetchEvent({
      kinds:   [KIND_HANDLER_RECOMMENDATION],
      authors: [pubkey],
      '#d':    [RECOMMENDATION_DTAG_LISTING],
    })
    if (!ev) return null
    const handlers = []
    for (const t of (ev.tags || [])) {
      if (!Array.isArray(t) || t[0] !== 'a' || !t[1]) continue
      // Only keep kind-31990 refs — defensive against future spec
      // additions or cross-client tags we don't recognise.
      if (!t[1].startsWith(`${KIND_HANDLER_INFORMATION}:`)) continue
      handlers.push({
        coord:     t[1],
        relayHint: t[2] || '',
        platform:  t[3] || '',
      })
    }
    return { event: ev, handlers }
  } catch {
    return null
  }
}

/**
 * Delete the seller's recommendation via NIP-09 kind 5. Used when the
 * seller wants to clear their pick rather than swap it. Replaceables
 * support this — once the deletion propagates, the next read returns
 * no recommendation.
 */
export async function deleteCheckoutAppRecommendation(eventId) {
  if (!eventId) return
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  const me = ndk.activeUser?.pubkey
  if (!me) throw new Error('No active user')

  const tags = [
    ['e', eventId],
    ['a', `${KIND_HANDLER_RECOMMENDATION}:${me}:${RECOMMENDATION_DTAG_LISTING}`],
    ['k', String(KIND_HANDLER_RECOMMENDATION)],
    ['client', 'mynostr'],
  ]
  const ev = new NDKEvent(ndk)
  ev.kind = 5
  ev.content = ''
  ev.created_at = Math.floor(Date.now() / 1000)
  ev.tags = tags

  await signWithTimeout(ev)
  await publishToOwnOutbox(ev)
}
