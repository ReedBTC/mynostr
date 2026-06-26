/**
 * Currency conversion — BTC/sats ↔ fiat via mempool.space.
 *
 * Why mempool.space: single endpoint, no auth, zero deps, Bitcoin-native.
 * Returns USD/EUR/GBP/CAD/CHF/AUD/JPY in one ~200-byte response. Trade-
 * off vs Yadio is currency coverage — if/when we need MXN/BRL/INR/etc.
 * we swap the fetcher; the rest of the module's public API stays.
 *
 * Cache strategy:
 *   • In-memory rate object — survives a tab session, no parsing cost.
 *   • localStorage backstop — survives reloads + tabs. Stale-while-
 *     revalidate so the composer doesn't block on a fresh fetch when an
 *     in-progress draft is being edited.
 *   • Module-level Promise dedupe — concurrent callers (Sell composer +
 *     My Selling list rendering simultaneously) share the same fetch.
 */

import { storageKey } from './brand.js'

const ENDPOINT = 'https://mempool.space/api/v1/prices'
const STORAGE_KEY = storageKey('currency_rates_v1')
const TTL_MS = 5 * 60 * 1000  // 5 minutes — matches the upstream's own cache cadence

const SATS_PER_BTC = 100_000_000

// Currencies the upstream actually returns. Any code outside this set
// resolves to "no rate" rather than fetching an unsupported one.
export const SUPPORTED_FIATS = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY']

let memCache = null      // { time, rates: { USD, EUR, ... }, fetchedAt }
let inflight = null      // Promise dedupe for concurrent fetches

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.rates) return null
    return parsed
  } catch {
    return null
  }
}
function writeStorage(payload) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)) } catch {}
}

function isFresh(payload) {
  if (!payload?.fetchedAt) return false
  return (Date.now() - payload.fetchedAt) < TTL_MS
}

async function doFetch() {
  const res = await fetch(ENDPOINT, { mode: 'cors' })
  if (!res.ok) throw new Error(`mempool.space ${res.status}`)
  const data = await res.json()
  // Defensive parse — strip everything to a plain { CODE: number } map so
  // a future upstream change to (say) add a "metadata" key doesn't blow
  // up the consumers.
  const rates = {}
  for (const code of SUPPORTED_FIATS) {
    const v = Number(data?.[code])
    if (Number.isFinite(v) && v > 0) rates[code] = v
  }
  if (Object.keys(rates).length === 0) throw new Error('mempool.space returned no usable rates')
  const payload = { rates, fetchedAt: Date.now(), upstreamTime: Number(data?.time) || null }
  memCache = payload
  writeStorage(payload)
  return payload
}

/**
 * Get current BTC/fiat rates. Returns the cached object when fresh;
 * otherwise refetches. `{ allowStale: true }` returns the cached value
 * even if expired, never throwing — useful in render paths where
 * displaying a stale price beats a flash of "—".
 *
 * Returned shape: { rates: { USD: 67000, EUR: 62000, ... }, fetchedAt, upstreamTime }
 */
export async function getRates({ allowStale = false } = {}) {
  if (memCache && isFresh(memCache)) return memCache
  if (!memCache) memCache = readStorage()
  if (memCache && isFresh(memCache)) return memCache
  if (allowStale && memCache) {
    // Kick off a refresh in the background but return immediately so
    // the caller doesn't block. Errors are swallowed — next non-stale
    // call will retry.
    if (!inflight) inflight = doFetch().catch(() => null).finally(() => { inflight = null })
    return memCache
  }
  if (inflight) return inflight
  inflight = doFetch().finally(() => { inflight = null })
  try {
    return await inflight
  } catch (e) {
    // Last-resort: return whatever we have, even if expired — better than
    // nothing for the caller's UI.
    if (memCache) return memCache
    throw e
  }
}

/**
 * Synchronous accessor — returns cached rates or null. Use in render
 * paths. Pair with `prefetchRates()` somewhere upstream so the cache is
 * warm by the time render fires.
 */
export function getCachedRates() {
  if (memCache) return memCache
  memCache = readStorage()
  return memCache
}

/** Warm the cache. Safe to call repeatedly — dedupe + freshness handle reentry. */
export async function prefetchRates() {
  try { await getRates({ allowStale: true }) } catch {}
}

// ─── Conversion helpers ────────────────────────────────────────────────────
//
// All conversions go through "BTC" as the pivot. mempool.space gives us
// 1 BTC = N {fiat}, so:
//   sats → fiat: (sats / 1e8) * rate
//   fiat → sats: (fiat / rate) * 1e8
//
// Inputs treated as numbers; bad inputs return null (no NaN propagation
// into the UI). Currency code lookups are case-insensitive.

export function satsToFiat(sats, currency, ratesObj) {
  const n = Number(sats)
  if (!Number.isFinite(n)) return null
  const rates = (ratesObj || getCachedRates())?.rates
  if (!rates) return null
  const code = String(currency || '').toUpperCase()
  const rate = rates[code]
  if (!Number.isFinite(rate) || rate <= 0) return null
  return (n / SATS_PER_BTC) * rate
}

export function fiatToSats(amount, currency, ratesObj) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  const rates = (ratesObj || getCachedRates())?.rates
  if (!rates) return null
  const code = String(currency || '').toUpperCase()
  const rate = rates[code]
  if (!Number.isFinite(rate) || rate <= 0) return null
  return Math.round((n / rate) * SATS_PER_BTC)
}

/**
 * Format a numeric amount for display. Currency-aware:
 *   • SATS / BTC → integer with thin-space thousand separators
 *   • Fiat       → 2 decimals (JPY: 0 decimals — yen has no minor units)
 *
 * Returns '' when the input isn't usable, so callers can drop the
 * resulting string straight into JSX without conditional rendering.
 */
export function formatAmount(amount, currency) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return ''
  const code = String(currency || '').toUpperCase()
  if (code === 'SATS') return Math.round(n).toLocaleString('en-US')
  if (code === 'BTC')  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  const fractionDigits = code === 'JPY' ? 0 : 2
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(n)
  } catch {
    // Bad currency code — fall back to plain number with the code suffixed.
    return `${n.toFixed(fractionDigits)} ${code}`
  }
}
