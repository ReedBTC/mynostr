/**
 * Donation Boostagram — core logic (V4V 2.0 standard, first implementation)
 *
 * Flow overview:
 *   1. Resolve project owner's lud16 from their Nostr kind 0 profile
 *   2. Fetch LNURL pay metadata from that lud16
 *   3. Request a bolt11 invoice from the LNURL callback
 *   4. Extract the payment_hash from the bolt11 (inline decoder — no dep required)
 *   5. Build a kind 30078 "donation_boostagram" event with a burner keypair
 *      d tag = payment_hash links this event to the specific invoice
 *   6. Sign and publish the event to relays
 *   7. Return the bolt11 + event ID for display / polling
 *
 * NOTE — description_hash:
 *   The full spec calls for description_hash = sha256(kind_30078_event_id) in the
 *   bolt11 invoice, creating a bidirectional link. This requires controlling the
 *   Lightning node that generates the invoice (custom backend).
 *   With standard LNURL-pay (e.g. Alby), the server sets description_hash to
 *   sha256(lnurl_metadata) and we cannot override it.
 *
 *   Current linking: kind 30078 d-tag = payment_hash (unidirectional but sufficient).
 *   To query: filter relays for kind 30078 #d=<payment_hash>.
 *   Backend seam: src/functions/api/boost.js (stubbed) will handle this when ready.
 */

import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { FALLBACK_RELAYS } from './ndk.js'

// ─── Project owner constants ────────────────────────────────────────────────
// TODO: replace with your actual npub (find it in your Nostr client or at njump.me).
// This is used to fetch your kind 0 profile → lud16 at runtime.
export const PROJECT_OWNER_NPUB = 'npub1v3rlad7z2v5u4hnpy7eh2fe3rtyfcv2exvdfpalek0ql2982fekqt37xu5'

// Hard fallback if kind 0 fetch fails
export const FALLBACK_LUD16 = 'nostrmd@getalby.com'

// Validate that a lud16 looks like a valid lightning address
const LUD16_RE = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+$/

// Relays used for kind 0 lookups and kind 30078 publishing
const BOOSTAGRAM_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://purplepag.es',
]

// ─── bolt11 payment hash extractor ──────────────────────────────────────────
// Minimal inline decoder — avoids adding a bolt11 dep.
// Decodes the bech32 data section, skips the 35-bit timestamp, then walks
// tagged fields until it finds tag type 1 (payment hash, 52 5-bit words = 32 bytes).
export function bolt11PaymentHash(invoice) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const str = invoice.toLowerCase()
  const sep = str.lastIndexOf('1')
  if (sep < 0) return null

  // Decode bech32 data words (drop 6-char checksum)
  const dataStr = str.slice(sep + 1, str.length - 6)
  const words = []
  for (const c of dataStr) {
    const v = CHARSET.indexOf(c)
    if (v < 0) break  // invalid chars appear in the checksum region — stop, don't abort
    words.push(v)
  }

  // Skip 35-bit timestamp (7 × 5-bit words)
  let i = 7

  while (i + 2 < words.length) {
    const tag = words[i]
    const len = (words[i + 1] << 5) | words[i + 2]
    i += 3
    if (i + len > words.length) break

    // Tag 1 = payment hash (52 words → 32 bytes)
    if (tag === 1 && len === 52) {
      const fieldWords = words.slice(i, i + 52)
      const bytes = []
      let acc = 0, bits = 0
      for (const w of fieldWords) {
        acc = (acc << 5) | w
        bits += 5
        if (bits >= 8) {
          bits -= 8
          bytes.push((acc >> bits) & 0xff)
        }
      }
      return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
    }
    i += len
  }
  return null
}

// ─── Burner keypair ──────────────────────────────────────────────────────────
// New random keypair for each boost — never written to storage, discarded after use.
export function generateBurnerKeypair() {
  const sk = generateSecretKey()   // Uint8Array
  const pk = getPublicKey(sk)      // hex string
  return { sk, pk }
}

// ─── Kind 0 resolution ───────────────────────────────────────────────────────
// Fetch a pubkey's kind 0 event from relays and return the parsed content object.
export async function fetchKind0(pubkeyHex) {
  const pool = new SimplePool()
  try {
    const event = await Promise.race([
      pool.get(BOOSTAGRAM_RELAYS, { kinds: [0], authors: [pubkeyHex] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    if (!event) return null
    return JSON.parse(event.content)
  } finally {
    pool.close(BOOSTAGRAM_RELAYS)
  }
}

// Resolve the lud16 lightning address for a project owner npub.
// Returns the lud16 string, or throws if none found.
export async function resolveRecipientLud16(ownerNpub) {
  let pubkeyHex
  try {
    const decoded = nip19.decode(ownerNpub)
    pubkeyHex = decoded.data
  } catch {
    throw new Error('Invalid npub')
  }

  const profile = await fetchKind0(pubkeyHex)
  if (!profile?.lud16) throw new Error('No lightning address in this profile')
  return profile.lud16
}

// ─── LNURL-pay helpers ───────────────────────────────────────────────────────
export async function fetchLnurlMeta(lud16) {
  if (!LUD16_RE.test(lud16)) throw new Error('Invalid lightning address format')
  const [name, domain] = lud16.split('@')
  const res = await fetch(`https://${domain}/.well-known/lnurlp/${name}`)
  if (!res.ok) throw new Error(`Failed to reach lightning address (${res.status})`)
  return res.json()
}

// Returns { pr: bolt11String, verify: verifyUrlOrNull }
export async function fetchLnurlInvoice(callbackUrl, amountMsats, comment) {
  if (!callbackUrl.startsWith('https://')) throw new Error('LNURL callback must use HTTPS')
  const url = new URL(callbackUrl)
  url.searchParams.set('amount', String(amountMsats))
  if (comment) url.searchParams.set('comment', comment)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Invoice request failed (${res.status})`)
  const data = await res.json()
  if (data.status === 'ERROR') throw new Error(data.reason || 'Unknown error from server')
  return { pr: data.pr, verify: data.verify || null }
}

// ─── Kind 30078 donation boostagram ─────────────────────────────────────────
/**
 * Build, sign, and publish a kind 30078 donation_boostagram event.
 *
 * @param {object} params
 * @param {Uint8Array} params.burnerSk        - Secret key (ephemeral — caller discards after this)
 * @param {string}     params.paymentHash     - Hex payment hash from the bolt11 invoice
 * @param {string}     params.donorNpub       - Full npub of the donor (from their Nostr session)
 * @param {string}     params.recipientLud16  - lud16 of the recipient
 * @param {number}     params.amountMsats     - Amount in millisatoshis
 * @param {string}     params.message         - Donor's message (may be empty)
 * @param {string}     params.pageUrl         - Current page URL
 * @returns {Promise<{eventId: string, published: boolean}>}
 */
export async function publishDonationBoostagram({
  burnerSk,
  paymentHash,
  donorNpub,
  recipientLud16,
  amountMsats,
  message,
  pageUrl,
}) {
  const eventTemplate = {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    content: message || '',
    tags: [
      ['d', paymentHash],
      ['app', 'nostrmd', '1.0.0'],
      ['type', 'donation_boostagram'],
      ['sender', donorNpub],
      ['recipient', recipientLud16],
      ['amount', String(amountMsats)],
      ['url', pageUrl],
    ],
  }

  const signedEvent = finalizeEvent(eventTemplate, burnerSk)

  const pool = new SimplePool()
  let published = false
  try {
    const results = await Promise.allSettled(
      pool.publish(BOOSTAGRAM_RELAYS, signedEvent).map(p =>
        Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))])
      )
    )
    published = results.some(r => r.status === 'fulfilled')
  } finally {
    pool.close(BOOSTAGRAM_RELAYS)
  }

  return { eventId: signedEvent.id, published }
}

// ─── LUD-21 payment verify poller ────────────────────────────────────────────
// Returns a cancel function. Calls onSettled() once when the invoice is paid.
export function pollVerify(verifyUrl, intervalMs, onSettled) {
  if (!verifyUrl.startsWith('https://')) return () => {}
  let active = true
  async function tick() {
    if (!active) return
    try {
      const res = await fetch(verifyUrl)
      if (res.ok) {
        const data = await res.json()
        if (data.settled) { onSettled(); return }
      }
    } catch { /* network blip — keep polling */ }
    if (active) setTimeout(tick, intervalMs)
  }
  tick()
  return () => { active = false }
}
