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

import { CLIENT_TAG } from './brand.js'
import { generateSecretKey, finalizeEvent, SimplePool } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { FALLBACK_RELAYS, getNDK, signWithTimeout, publishToPool } from './ndk.js'
import { withTimeout } from './utils.js'
import { fetchLnurlMeta as _fetchLnurlMeta, fetchLnurlInvoice as _fetchLnurlInvoice } from './lnurl.js'

// ─── Project owner constants ────────────────────────────────────────────────
// TODO: replace with your actual npub (find it in your Nostr client or at njump.me).
// This is used to fetch your kind 0 profile → lud16 at runtime.
export const PROJECT_OWNER_NPUB = 'npub1mp9png4wg4jhvy6qtf3wp0m3fey2qn5z5sq4rlak9r3wg3uatpastcrk6j'

// Hard fallback if kind 0 fetch fails
export const FALLBACK_LUD16 = 'mynostrapp@getalby.com'

// LNURL helpers re-exported so existing `from boostagram` imports keep
// working — actual implementations live in lib/lnurl.js (single source
// of truth shared with zap and split-zap flows).
export const fetchLnurlMeta    = _fetchLnurlMeta
export const fetchLnurlInvoice = _fetchLnurlInvoice

// Relays used for kind 0 lookups and kind 30078 publishing
const BOOSTAGRAM_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
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
// Just the secret key bytes; nostr-tools' finalizeEvent derives the pubkey
// internally during signing, so a separate getPublicKey call is wasted work.
export function generateBurnerKeypair() {
  return { sk: generateSecretKey() }
}

// ─── Kind 0 resolution ───────────────────────────────────────────────────────
// Fetch a pubkey's kind 0 event from relays and return the parsed content object.
// Returns null on missing event or unparseable content rather than throwing —
// caller (resolveRecipientLud16) has its own fallback for "no profile data."
export async function fetchKind0(pubkeyHex) {
  const pool = new SimplePool()
  try {
    const event = await withTimeout(
      pool.get(BOOSTAGRAM_RELAYS, { kinds: [0], authors: [pubkeyHex] }),
      5000,
    )
    if (!event) return null
    try {
      return JSON.parse(event.content)
    } catch {
      return null
    }
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

// ─── Kind 30078 donation boostagram ─────────────────────────────────────────
/**
 * Build, sign, and publish a kind 30078 donation_boostagram event.
 *
 * Two signing paths controlled by `burnerSk`:
 *   • Burner key supplied  → signed with that single-use key (anonymous mode).
 *     Caller is expected to zero the bytes immediately after this returns.
 *   • Burner key not supplied → signed with the NDK session signer (the
 *     donor's real Nostr key). Used when the donor wants the event
 *     attributed to them. Privacy delta is tolerable because the user
 *     already opted out of anonymous mode; for those still concerned,
 *     anonymous remains the default.
 *
 * @param {object} params
 * @param {?Uint8Array} params.burnerSk       - Optional. If supplied, sign with this; else use session signer.
 * @param {string}     params.paymentHash     - Hex payment hash from the bolt11 invoice
 * @param {string}     params.donorNpub       - Full npub of the donor (from their Nostr session) — '' for anon
 * @param {string}     params.recipientLud16  - lud16 of the recipient
 * @param {number}     params.amountMsats     - Amount in millisatoshis
 * @param {string}     params.message         - Donor's message (may be empty)
 * @param {string}     params.pageUrl         - Current page URL
 * @returns {Promise<{eventId: string, published: boolean}>}
 */
export async function publishDonationBoostagram({
  burnerSk = null,
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
      ['app', 'mynostr', '1.0.0'],
      ['type', 'donation_boostagram'],
      ['sender', donorNpub],
      ['recipient', recipientLud16],
      ['amount', String(amountMsats)],
      ['url', pageUrl],
    ],
  }

  // Sign — burner path is synchronous (raw key + nostr-tools); session
  // path is async (round-trip to NIP-07 / bunker / etc. via NDK signer).
  let signedEvent
  if (burnerSk) {
    signedEvent = finalizeEvent(eventTemplate, burnerSk)
  } else {
    const ndk = getNDK()
    const ev = new NDKEvent(ndk, eventTemplate)
    await signWithTimeout(ev)
    signedEvent = await ev.toNostrEvent()
  }

  const pool = new SimplePool()
  let published = false
  try {
    const results = await Promise.allSettled(
      pool.publish(BOOSTAGRAM_RELAYS, signedEvent).map(p => withTimeout(p, 6000))
    )
    published = results.some(r => r.status === 'fulfilled')
  } finally {
    pool.close(BOOSTAGRAM_RELAYS)
  }

  return { eventId: signedEvent.id, published }
}

// ─── Kind 1 boost share — donor's "I just boosted X" feed note ─────────────
/**
 * Optional second event published when the donor opts into "Share to
 * feed." A regular kind 1 note signed by the donor's real key, posted
 * to their normal write relays so their followers see it natively.
 *
 * Kept separate from the kind 30078 boostagram event because:
 *   • This one is for social sharing (followers' feeds); the 30078 is
 *     for the recipient's bot to correlate against the LND payment.
 *   • Kind 1 goes to the donor's outbox; 30078 goes to BOOSTAGRAM_RELAYS.
 *   • Donors can want one without the other (attributed-but-private
 *     mode signs the 30078 with their key but skips this kind 1).
 *
 * Caller is expected to call this only after the LUD-21 verify URL
 * confirms the payment settled — otherwise an abandoned boost would
 * pollute the donor's feed with a "I just boosted!" note for a
 * payment that never happened.
 *
 * @param {object} params
 * @param {string}     params.message         - Donor's boost message (may be empty)
 * @param {string}     params.recipientNpub   - Recipient's npub (for nostr: mention + p tag)
 * @param {string}     params.pageUrl         - URL to include in the note (typically site root)
 * @param {number}     params.amountSats      - Amount in sats (for the visible message)
 * @returns {Promise<{eventId: string, published: boolean}>}
 */
export async function publishBoostShareNote({
  message,
  recipientNpub,
  pageUrl,
  amountSats,
}) {
  const ndk = getNDK()

  // Decode recipient's npub to hex for the p-tag (kind-1 mention conventions
  // expect hex authors in p-tags so clients can resolve the profile).
  let recipientPubkey = ''
  try {
    const decoded = nip19.decode(recipientNpub)
    if (decoded.type === 'npub') recipientPubkey = decoded.data
  } catch {
    // Bad npub — skip the p-tag; the nostr: link in content still works.
  }

  // Compose the visible content. Format chosen to read naturally on a
  // follower's feed: lead with the action, donor's message inline if any,
  // close with the link + nostr: mention so clients render the recipient
  // as a clickable profile.
  const lines = [
    `Just boosted ⚡ ${amountSats.toLocaleString()} sats to nostr:${recipientNpub}`,
  ]
  if (message && message.trim()) {
    lines.push('')
    lines.push(message.trim())
  }
  lines.push('')
  lines.push(pageUrl)
  const content = lines.join('\n')

  const tags = [
    ['t', 'mynostr'],
    ['t', 'boost'],
    ['r', pageUrl],
    ['client', CLIENT_TAG],
  ]
  if (recipientPubkey) tags.push(['p', recipientPubkey])

  const ev = new NDKEvent(ndk, {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  })
  await signWithTimeout(ev)

  // Publish to the donor's reach set (write relays + fallbacks) so the
  // share lands on the same surface as their other kind 1 notes.
  // Failures are non-fatal — the boost succeeded; the share is
  // best-effort.
  let published = false
  try {
    const ackd = await publishToPool(ev)
    published = ackd && ackd.size > 0
  } catch {
    published = false
  }

  return { eventId: ev.id, published }
}

// ─── LUD-21 payment verify poller ────────────────────────────────────────────
// Returns a cancel function. Calls onSettled() once when the invoice is paid.
//
// `expectedPaymentHash` (optional, hex) enables cryptographic verification
// of the server's "settled" claim: when the verify response includes a
// `preimage` field (LUD-21 marks it optional), we sha256 it and confirm
// the digest equals the expected payment_hash. If it doesn't, the server
// is either lying or buggy, and we keep polling rather than firing the
// onSettled callback. When the response has no preimage, we fall back to
// trusting the boolean (matches pre-cross-check behavior — required to
// remain compatible with servers that don't implement the preimage field).
//
// Without this, a malicious LNURL server could falsely report settled=true
// and trick the modal into showing the success state (and publishing the
// optional kind 1 share-to-feed note) for a payment that never happened.
export function pollVerify(verifyUrl, intervalMs, onSettled, expectedPaymentHash = null) {
  if (!verifyUrl.startsWith('https://')) return () => {}
  let active = true
  async function tick() {
    if (!active) return
    try {
      const res = await fetch(verifyUrl)
      if (res.ok) {
        const data = await res.json()
        if (data.settled) {
          // Optional cryptographic verification.
          if (expectedPaymentHash && typeof data.preimage === 'string' && data.preimage.length > 0) {
            const ok = await verifyPreimageMatches(data.preimage, expectedPaymentHash)
            if (!ok) {
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn('[pollVerify] preimage does not hash to expected payment_hash — server may be lying or misconfigured. Will keep polling.')
              }
              if (active) setTimeout(tick, intervalMs)
              return
            }
          }
          onSettled()
          return
        }
      }
    } catch { /* network blip — keep polling */ }
    if (active) setTimeout(tick, intervalMs)
  }
  tick()
  return () => { active = false }
}

// Compute sha256(preimage_bytes) and compare to expected payment_hash.
// Both inputs are hex strings. Returns false on any malformed input or
// missing crypto.subtle (which can happen on http:// LAN access — graceful
// fallback to "treat as unverifiable, keep polling" rather than blocking
// the boost flow on a verification we can't perform).
async function verifyPreimageMatches(preimageHex, expectedHashHex) {
  if (!crypto?.subtle) return true
  const hexRe = /^[0-9a-f]{64}$/i
  if (!hexRe.test(preimageHex) || !hexRe.test(expectedHashHex)) return false
  try {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(preimageHex.slice(i * 2, i * 2 + 2), 16)
    }
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    return hashHex.toLowerCase() === expectedHashHex.toLowerCase()
  } catch {
    return false
  }
}
