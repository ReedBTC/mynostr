/**
 * Sequential NIP-57 zap-split orchestrator.
 *
 * Given a target event with zap-split tags, pay each recipient's share
 * via the user's connected wallet (NWC or WebLN — NWC takes precedence
 * when both are present). Each leg: resolve lud16 from the recipient's
 * kind 0 → build + sign a NIP-57 zap-request (kind 9734) targeting THAT
 * recipient's pubkey but referencing the original event → fetch a
 * bolt11 from the recipient's LNURL with the signed zap-request
 * attached → pay via the active wallet adapter.
 *
 * Why sequential payInvoice (not parallel): NWC's reply-event subscription
 * gets noisy when multiple payInvoice round-trips are in flight (validated
 * by the LB implementation we forked from — they hit timeouts at 5+
 * parallel legs in production). One slow leg cascades into later legs
 * timing out at the SDK's 60s default. Serializing trades a few seconds
 * of total latency for meaningfully higher reliability.
 *
 * Best-effort semantics: a single leg failure (no lud16, share below
 * minSendable, signer rejected, wallet error) doesn't kill the batch —
 * subsequent legs still run. The function never throws; it returns
 * per-leg results so the UI can decide what to surface.
 *
 * @param {object}   args
 * @param {Array}    args.splits          [{ pubkey, weight, pct }]
 * @param {Array}    args.allocations     [{ pubkey, msats, ... }] from allocateMsats
 * @param {object}   args.targetEvent     The note/article being zapped
 * @param {?string}  args.aTag            Addressable coord (kind:pubkey:dtag) when applicable
 * @param {?string}  args.targetKind      Kind of the target (1, 30023, etc.)
 * @param {string}   args.comment         User's zap comment (passed to LNURL)
 * @param {function} [args.onLegSettle]   (legResult, index) callback fired as each leg lands
 * @returns {Promise<{ legs, anySucceeded, allSucceeded }>}
 */

import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, FALLBACK_RELAYS, signWithTimeout } from './ndk.js'
import { fetchProfiles } from './primal.js'
import { fetchLnurlMeta, fetchLnurlInvoice } from './lnurl.js'
import * as nwc from './nwc.js'
import * as webln from './webln.js'

// NWC takes precedence when both are connected (NWC = explicit; WebLN
// can re-enable silently from the persisted flag). Mirrors ZapModal.
function payInvoiceViaActiveWallet(bolt11) {
  if (nwc.isReady())   return nwc.payInvoice(bolt11)
  if (webln.isReady()) return webln.payInvoice(bolt11)
  return Promise.reject(new Error('No wallet connected'))
}
function anyWalletReady() {
  return nwc.isReady() || webln.isReady()
}

async function buildSignedZapRequest({
  recipientPubkey, targetEvent, aTag, targetKind, amountMsats, comment,
}) {
  const ndk = getNDK()
  const ev = new NDKEvent(ndk)
  ev.kind = 9734
  ev.content = comment || ''
  ev.tags = [
    ['p', recipientPubkey],
    ['amount', String(amountMsats)],
    ['relays', ...FALLBACK_RELAYS],
  ]
  if (aTag) ev.tags.push(['a', aTag])
  if (targetEvent?.id) ev.tags.push(['e', targetEvent.id])
  if (targetKind) ev.tags.push(['k', String(targetKind)])
  await signWithTimeout(ev)
  return JSON.stringify(ev.rawEvent())
}

export async function payZapSplits({
  splits,
  allocations,
  targetEvent,
  aTag,
  targetKind,
  comment,
  onLegSettle,
}) {
  // Pre-fetch all recipient profiles in one Primal call so per-leg work
  // doesn't pay the round-trip cost individually. fetchProfiles caches,
  // so repeat zaps in the same session are free.
  const pubkeys = splits.map(s => s.pubkey)
  let profileMap = new Map()
  try {
    profileMap = await fetchProfiles(pubkeys)
  } catch (e) {
    console.warn('[mynostr-nwc] split: profile prefetch failed', e?.message || e)
    // Continue anyway — per-leg lud16 lookup will just have to fail
    // legs without a cached profile.
  }

  // Caller should have checked anyWalletReady() before calling, but
  // short-circuit cleanly if not.
  if (!anyWalletReady()) {
    return {
      legs: allocations.map(a => ({
        recipient: { ...a, lud16: null },
        msats: a.msats,
        status: 'failed',
        error: 'No wallet connected',
      })),
      anySucceeded: false,
      allSucceeded: false,
    }
  }

  const results = []
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i]
    const profile = profileMap.get(a.pubkey)
    const lud16 = profile?.lud16 || null
    const recipient = { pubkey: a.pubkey, weight: a.weight, pct: a.pct, lud16 }

    let legResult
    if (!lud16) {
      legResult = {
        recipient, msats: a.msats,
        status: 'no-lud16',
        error: 'No Lightning address on profile',
      }
    } else {
      try {
        const meta = await fetchLnurlMeta(lud16)
        if (typeof meta.minSendable === 'number' && a.msats < meta.minSendable) {
          legResult = {
            recipient, msats: a.msats,
            status: 'amount-too-small',
            error: `Min ${Math.ceil(meta.minSendable / 1000).toLocaleString()} sats`,
          }
        } else {
          let zapRequestJson = null
          if (meta.allowsNostr && meta.nostrPubkey) {
            zapRequestJson = await buildSignedZapRequest({
              recipientPubkey: a.pubkey,
              targetEvent,
              aTag,
              targetKind,
              amountMsats: a.msats,
              comment,
            })
          }
          const { pr } = await fetchLnurlInvoice(meta.callback, a.msats, comment, zapRequestJson)
          await payInvoiceViaActiveWallet(pr)
          legResult = { recipient, msats: a.msats, status: 'paid' }
        }
      } catch (e) {
        const msg = String(e?.message || e)
        console.warn(`[mynostr-nwc] split leg ${i + 1}/${allocations.length} (${a.pubkey.slice(0, 8)}…) failed:`, msg)
        legResult = {
          recipient, msats: a.msats,
          status: 'failed',
          error: msg,
        }
      }
    }

    results.push(legResult)
    onLegSettle?.(legResult, i)
  }

  return {
    legs: results,
    anySucceeded: results.some(r => r.status === 'paid'),
    allSucceeded: results.every(r => r.status === 'paid'),
  }
}
