/**
 * gammaCompliance.js — single source of truth for grading a MyNostr
 * marketplace surface against the Gamma Markets spec
 * (https://github.com/GammaMarkets/market-spec).
 *
 * Spec quotes pinned in docs/gamma-spec-snapshot.md; refresh that file
 * before changing the rules below.
 *
 * Two graders:
 *   - gradeListing(parsedProduct, sellerShippingOptions)
 *   - gradeProfile(kind0Event)
 *
 * Each returns:
 *   {
 *     ready: boolean,                   // no warning/error gaps present
 *     score: number,                    // 0-100, for header summaries
 *     gaps: Array<{
 *       code: string,                   // GAP_*
 *       severity: 'error'|'warning'|'info',
 *       label: string,                  // human-readable summary for UI
 *       fix: string,                    // imperative one-liner ("Add a
 *                                       // shipping option") for the action button
 *     }>,
 *   }
 *
 * Severity → score deduction:
 *   error   → -50 (listing breaks in third-party checkout flows)
 *   warning → -20 (works as manual checkout but loses automation)
 *   info    → 0   (optional improvements, surfaced for visibility only)
 *
 * Gaps are intentionally additive — UIs can render them as a flat list,
 * group by severity, or filter to error+warning for the score-affecting
 * subset.
 */

import { KIND_PRODUCT, KIND_SHIPPING_OPTION } from './gamma.js'

// ── Gap codes ────────────────────────────────────────────────────────────────
// Exposed as constants so consumers can match without typo-prone string
// literals. Names mirror the user-facing problem, not the technical rule.

export const GAP_NO_SHIPPING_OPTION             = 'NO_SHIPPING_OPTION'
export const GAP_FREE_TEXT_ONLY_SHIPPING        = 'FREE_TEXT_ONLY_SHIPPING'
export const GAP_SHIPPING_REF_UNRESOLVED        = 'SHIPPING_REF_UNRESOLVED'
export const GAP_SHIPPING_OPTION_INVALID_SERVICE = 'SHIPPING_OPTION_INVALID_SERVICE'
export const GAP_SHIPPING_OPTION_MISSING_COUNTRY = 'SHIPPING_OPTION_MISSING_COUNTRY'
export const GAP_NO_PAYMENT_PREFERENCE          = 'NO_PAYMENT_PREFERENCE'
export const GAP_INVALID_PAYMENT_PREFERENCE     = 'INVALID_PAYMENT_PREFERENCE'
export const GAP_NO_CHECKOUT_APP_RECOMMENDATION = 'NO_CHECKOUT_APP_RECOMMENDATION'

// Per-severity score weight. Centralised so future tuning is one place.
const WEIGHT = { error: 50, warning: 20, info: 0 }

// Spec-mandated enum for kind 30406 `service` (docs/gamma-spec-snapshot.md §3).
export const SERVICE_VALUES = ['standard', 'express', 'overnight', 'pickup']
const SERVICE_SET = new Set(SERVICE_VALUES)

// Spec-mandated enum for kind-0 `payment_preference` (docs/gamma-spec-snapshot.md §1).
export const PAYMENT_PREFERENCE_VALUES = ['manual', 'lud16', 'ecash']
const PAYMENT_PREFERENCE_SET = new Set(PAYMENT_PREFERENCE_VALUES)

// Heading the Sell composer appends when a seller types free-text shipping
// notes — see sellForm.js where this exact marker is written and re-parsed.
// Detecting it lets us tell "no shipping info at all" apart from "shipping
// info present, but only as prose."
const FREE_TEXT_SHIPPING_MARKER = '\n## Shipping\n\n'

// ── Helpers ──────────────────────────────────────────────────────────────────

function summarize(gaps) {
  let score = 100
  for (const g of gaps) score -= WEIGHT[g.severity] ?? 0
  if (score < 0) score = 0
  // Ready = nothing worse than info. Errors and warnings both block the
  // "checkout-ready" label so a "manual checkout only" listing doesn't
  // get a green check.
  const ready = gaps.every(g => g.severity === 'info')
  return { ready, score, gaps }
}

// ── gradeListing ─────────────────────────────────────────────────────────────

/**
 * Grade a single 30402 listing for Gamma compliance.
 *
 * @param {object} parsed — decoded product (from gamma.decodeProduct).
 * @param {Array<object>} [sellerShippingOptions] — decoded 30406s the
 *   seller owns. Pass an empty array if not loaded yet — grader degrades
 *   gracefully and just skips ref-resolution checks.
 *
 * @returns {{ ready: boolean, score: number, gaps: Array<object> }}
 */
export function gradeListing(parsed, sellerShippingOptions = []) {
  if (!parsed || typeof parsed !== 'object') {
    return summarize([{
      code: GAP_NO_SHIPPING_OPTION,
      severity: 'error',
      label: 'Listing data unavailable',
      fix: 'Reload the listing',
    }])
  }

  const gaps = []
  const refs = Array.isArray(parsed.shippingOptionRefs) ? parsed.shippingOptionRefs : []
  const hasFreeTextShipping = typeof parsed.content === 'string'
    && parsed.content.includes(FREE_TEXT_SHIPPING_MARKER)

  if (refs.length === 0) {
    // No structured shipping at all — the load-bearing gap. Distinguish
    // "seller wrote prose but never structured it" from "no shipping
    // info anywhere" so the migration UI can offer the smarter fix
    // (parse the prose into a 30406) when applicable.
    if (hasFreeTextShipping) {
      gaps.push({
        code: GAP_FREE_TEXT_ONLY_SHIPPING,
        severity: 'warning',
        label: 'Shipping is described in prose only',
        fix: 'Convert your shipping notes into a structured shipping option',
      })
    } else {
      gaps.push({
        code: GAP_NO_SHIPPING_OPTION,
        severity: 'warning',
        label: 'No shipping option attached',
        fix: 'Add a shipping option so checkout apps can compute a quote',
      })
    }
  } else if (sellerShippingOptions.length > 0) {
    // We have refs AND we know what the seller's 30406s look like — verify
    // each ref resolves to one of the seller's own options. A foreign or
    // archived option is a soft warning, not a hard error: the listing
    // still works in apps that already cached the referenced 30406, just
    // not in apps fetching cold.
    const ownCoords = new Set(
      sellerShippingOptions
        .filter(s => s?.dTag && s?.pubkey)
        .map(s => `${KIND_SHIPPING_OPTION}:${s.pubkey}:${s.dTag}`)
    )
    const unresolved = refs
      .map(r => r?.ref || '')
      .filter(ref => ref && !ownCoords.has(ref))
    if (unresolved.length > 0) {
      gaps.push({
        code: GAP_SHIPPING_REF_UNRESOLVED,
        severity: 'warning',
        label: `${unresolved.length} shipping option ref${unresolved.length === 1 ? '' : 's'} can't be resolved`,
        fix: 'Re-attach a current shipping option',
      })
    }
  }

  return summarize(gaps)
}

// ── gradeProfile ─────────────────────────────────────────────────────────────

/**
 * Grade a kind-0 profile event for the merchant-side Gamma signals
 * (currently just `payment_preference`). Absence is *info-level* because
 * the spec defaults missing `payment_preference` to `manual` — i.e. a
 * profile with no tag is technically valid, just not as automation-
 * friendly as one that opts in.
 *
 * @param {object} kind0Event — raw NDKEvent or POJO with `tags` array.
 *   Pass `null` if the profile hasn't loaded yet — grader returns the
 *   same shape with one info-level gap for the missing preference.
 */
export function gradeProfile(kind0Event) {
  const tags = Array.isArray(kind0Event?.tags) ? kind0Event.tags : []
  const prefTag = tags.find(t => Array.isArray(t) && t[0] === 'payment_preference')

  const gaps = []

  if (!prefTag) {
    // Spec: missing tag = "manual" by default. Surface as info so the
    // seller knows they *could* opt into automation, but don't penalise
    // their score for accepting the default.
    gaps.push({
      code: GAP_NO_PAYMENT_PREFERENCE,
      severity: 'info',
      label: 'No payment preference set (defaults to manual)',
      fix: 'Pick how buyers should pay you',
    })
  } else {
    const value = String(prefTag[1] || '').toLowerCase()
    if (!PAYMENT_PREFERENCE_SET.has(value)) {
      // Tag exists but the value is outside the spec enum — treat as a
      // warning since third-party apps will likely fall back to manual
      // anyway, but the seller probably *intended* to opt in.
      gaps.push({
        code: GAP_INVALID_PAYMENT_PREFERENCE,
        severity: 'warning',
        label: `Payment preference "${value}" is not a recognised value`,
        fix: `Set payment preference to one of: ${PAYMENT_PREFERENCE_VALUES.join(', ')}`,
      })
    }
  }

  return summarize(gaps)
}

// ── gradeShippingOption ──────────────────────────────────────────────────────

/**
 * Grade a single 30406 shipping option for Gamma compliance. Used by the
 * Shipping Options tab to flag options that won't be picked up cleanly by
 * checkout apps. Required tags per the spec snapshot are d/title/price/
 * country/service; gamma.encodeShippingOption already enforces d+title,
 * so this grader focuses on the spec-mandated *values* and the runtime
 * fields the encoder doesn't validate.
 */
export function gradeShippingOption(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return summarize([{
      code: GAP_SHIPPING_REF_UNRESOLVED,
      severity: 'error',
      label: 'Shipping option data unavailable',
      fix: 'Reload the shipping option',
    }])
  }

  const gaps = []

  const countries = Array.isArray(parsed.countries) ? parsed.countries.filter(Boolean) : []
  if (countries.length === 0) {
    gaps.push({
      code: GAP_SHIPPING_OPTION_MISSING_COUNTRY,
      severity: 'warning',
      label: 'No countries listed',
      fix: 'Pick at least one country this option ships to',
    })
  }

  const service = String(parsed.service || '').toLowerCase()
  // Empty service is a missing-required-tag case, distinct from invalid:
  // surface both with the same code so the UI's fix flow is one button.
  if (!SERVICE_SET.has(service)) {
    gaps.push({
      code: GAP_SHIPPING_OPTION_INVALID_SERVICE,
      severity: 'warning',
      label: service
        ? `Service "${service}" isn't one of the standard values`
        : 'Service type missing',
      fix: `Pick a service type: ${SERVICE_VALUES.join(', ')}`,
    })
  }

  return summarize(gaps)
}

// ── gradeMerchant ────────────────────────────────────────────────────────────

/**
 * Roll up profile + every listing + every shipping option into a single
 * verdict for header summaries ("Compliance: 8/10 ready"). The score
 * here is the average of per-listing scores combined with the profile
 * score — weighting profile and listings equally feels right because
 * profile gaps affect *every* listing in practice.
 *
 * Returns the same shape as the per-item graders, plus:
 *   - listingCount, listingReadyCount: for "8/10 ready" UI copy
 */
export function gradeMerchant({ profile, listings = [], shippingOptions = [] }) {
  const profileResult = gradeProfile(profile)
  const listingResults = listings.map(p => gradeListing(p, shippingOptions))

  const allGaps = [
    ...profileResult.gaps.map(g => ({ ...g, scope: 'profile' })),
    ...listingResults.flatMap((r, i) =>
      r.gaps.map(g => ({ ...g, scope: 'listing', listingIndex: i }))
    ),
  ]

  const listingReadyCount = listingResults.filter(r => r.ready).length
  const listingScoreAvg = listingResults.length > 0
    ? Math.round(listingResults.reduce((sum, r) => sum + r.score, 0) / listingResults.length)
    : 100

  // Merchant-level score: average of profile and listing-average. Profile
  // gaps are info-only by design, so this typically tracks the listing
  // score closely — but a future error-severity profile gap would pull
  // the whole shop's score down, which is what we want.
  const score = Math.round((profileResult.score + listingScoreAvg) / 2)
  const ready = profileResult.ready && listingResults.every(r => r.ready)

  return {
    ready,
    score,
    gaps: allGaps,
    listingCount: listingResults.length,
    listingReadyCount,
  }
}

export { KIND_PRODUCT, KIND_SHIPPING_OPTION }
