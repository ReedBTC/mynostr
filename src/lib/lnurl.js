/**
 * LNURL-pay primitives shared across boost / zap / split-zap flows.
 *
 * Consolidates `fetchLnurlMeta` (well-known/lnurlp/<name> resolution) and
 * `fetchLnurlInvoice` (callback → bolt11) so a single set of timeout +
 * validation rules govern every Lightning-address fetch in the app.
 *
 * **Strict lud16 validation:** every entry point checks the address
 * against `LUD16_RE` to reject malformed input early — the loose
 * `name.split('@')` form would happily parse `name@domain@evil.com` (as
 * `[name, domain]`, dropping the rest) and we don't want that anywhere.
 *
 * **HTTPS-only callback:** servers might return any URL in `callback`,
 * so we hard-fail on non-https schemes before fetching. Browsers would
 * refuse `javascript:` / `file:` anyway, but explicit > implicit.
 *
 * **NOT SAFE FOR SERVER-SIDE USE.** These helpers fetch arbitrary
 * URL-shaped strings derived from third-party Nostr profile data
 * (kind 0 lud16 fields). In a browser, CORS + same-origin policy gate
 * what's reachable, so an SSRF attempt against an internal service from
 * a malicious split target is bounded. If any of this code ever runs in
 * a Cloudflare Worker, Node, or other server environment, the caller
 * MUST add explicit URL allowlisting (or at minimum, public-domain
 * resolution) before calling fetch.
 */

import { withTimeout } from './utils.js'

export const LUD16_RE = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+$/

const FETCH_TIMEOUT_MS = 10_000

/**
 * Resolve a lud16 to its LNURL-pay metadata (kind 6 .well-known
 * response). Throws on malformed input, network failure, or invalid
 * response shape.
 *
 * Returns the parsed JSON: { callback, minSendable, maxSendable,
 * commentAllowed?, allowsNostr?, nostrPubkey?, ... }.
 *
 * **NIP-57 recipient verification.** When `expectedPubkey` is provided
 * and the LNURL response advertises NIP-57 support (`allowsNostr` +
 * `nostrPubkey`), we verify `nostrPubkey === expectedPubkey`. A
 * mismatch means the LNURL provider is claiming to represent a
 * different Nostr identity than the one in the recipient's kind 0
 * profile — refusal protects against a poisoned profile or a malicious
 * LNURL operator silently redirecting zaps. Without an expectedPubkey,
 * we don't enforce (matches the boost flow which doesn't use NIP-57).
 */
export async function fetchLnurlMeta(lud16, { expectedPubkey } = {}) {
  if (typeof lud16 !== 'string' || !LUD16_RE.test(lud16)) {
    throw new Error('Invalid lightning address format')
  }
  const [name, domain] = lud16.split('@')
  const res = await withTimeout(
    fetch(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`),
    FETCH_TIMEOUT_MS,
    'lnurl-meta-timeout',
  )
  if (!res.ok) throw new Error(`Failed to reach lightning address (${res.status})`)
  const data = await res.json()
  if (!data || typeof data !== 'object') {
    throw new Error('LNURL metadata response was not an object')
  }
  if (typeof data.callback !== 'string' || !data.callback.startsWith('https://')) {
    throw new Error('LNURL metadata missing valid https callback URL')
  }
  if (typeof data.minSendable !== 'number' || typeof data.maxSendable !== 'number') {
    throw new Error('LNURL metadata missing min/maxSendable')
  }
  if (expectedPubkey && data.allowsNostr && data.nostrPubkey
      && data.nostrPubkey !== expectedPubkey) {
    throw new Error(
      'LNURL provider claims to represent a different Nostr pubkey than expected ' +
      '— refusing to send a NIP-57 zap-request to avoid mis-targeted zaps',
    )
  }
  return data
}

/**
 * Fetch a bolt11 invoice from an LNURL-pay callback. `zapRequestJson`,
 * when present, is attached as the `nostr` query parameter — required
 * by NIP-57 to get a zap-tagged invoice instead of a plain LNURL-pay
 * invoice.
 *
 * Returns { pr: bolt11String, verify: verifyUrlOrNull }.
 */
export async function fetchLnurlInvoice(callbackUrl, amountMsats, comment, zapRequestJson) {
  if (typeof callbackUrl !== 'string' || !callbackUrl.startsWith('https://')) {
    throw new Error('LNURL callback must use HTTPS')
  }
  const url = new URL(callbackUrl)
  url.searchParams.set('amount', String(amountMsats))
  if (comment && typeof comment === 'string' && comment.trim()) {
    url.searchParams.set('comment', comment.trim())
  }
  if (zapRequestJson) url.searchParams.set('nostr', zapRequestJson)
  const res = await withTimeout(
    fetch(url.toString()),
    FETCH_TIMEOUT_MS,
    'lnurl-invoice-timeout',
  )
  if (!res.ok) throw new Error(`Invoice request failed (${res.status})`)
  const data = await res.json()
  if (!data || typeof data !== 'object') {
    throw new Error('Invoice response was not an object')
  }
  if (data.status === 'ERROR') throw new Error(data.reason || 'Unknown error from server')
  if (typeof data.pr !== 'string' || !data.pr.toLowerCase().startsWith('lnbc')) {
    throw new Error('Invoice response missing valid bolt11 (pr field)')
  }
  return { pr: data.pr, verify: typeof data.verify === 'string' ? data.verify : null }
}
