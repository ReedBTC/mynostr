# Gamma Markets spec — verified snapshot

This file pins the exact spec language MyNostr's compliance tooling depends on,
so future code changes can diff against a known-good baseline rather than
re-reading the live spec each time.

- **Spec source:** https://github.com/GammaMarkets/market-spec (`spec.md`)
- **Spec status header:** `draft`
- **Snapshotted on:** 2026-05-08

If the live spec drifts from any of the quotes below, treat this as the
authoritative version for MyNostr's grader/encoder until the snapshot is
re-pulled and reviewed. Bump the date above when refreshing.

---

## 1. Merchant `payment_preference` (kind 0)

> "2. Payment Preferences:
> - Set via `payment_preference` tag in the merchant's kind `0` event
> - Valid values: `manual | ecash | lud16`
> - Defaults to `manual` if not specified"

Tag shape (also quoted from the spec's implementation example):

```
["payment_preference", "<manual | ecash | lud16>"]
```

**Implications for MyNostr:**

- Lives in `event.tags` on the user's kind 0, **not** inside the JSON content
  blob. `publishProfile.js` must round-trip event tags (it currently emits
  `event.tags = []` on the new event, which would clobber this tag if any
  other client set it).
- A profile with no `payment_preference` tag at all is **valid** and means
  "manual" — so absence is not a compliance failure on its own. Compliance
  grader treats absence as *info-level*, not warning.

## 2. Application recommendation (kind 31989, NIP-89)

> "1. Application Preferences ([NIP-89](89.md)):
> - The recommended application MUST publish a kind `31990` event
> - The merchant MUST publish a kind `31989` event recommending that application"

Spec defers full structural detail to NIP-89. For our purposes:

- Merchant publishes a kind 31989 pointing at the kind 31990 of the checkout
  app (Shopstr, Plebeian, etc.) they want orders routed through.
- This is **optional** — only matters if the seller wants to direct buyers
  toward a specific marketplace app. Compliance grader marks absence as
  info-level, never warning.

## 3. Kind 30406 — Shipping option required tags

> "**Required tags**:
> - `d`: Unique shipping option identifier
> - `title`: Display title for the shipping method
> - `price`: Base cost array `[<base_cost>, <currency>]`
> - `country`: Array of ISO 3166-1 alpha-2 country codes `[<code1>, <code2>, ...]`
> - `service`: Service type ('standard', 'express', 'overnight', 'pickup')"

**Format constraints called out by the spec:**

- `country` codes: ISO 3166-1 alpha-2 only (e.g. `US`, `GB`, `DE`).
- `service` is an **enum** with exactly four allowed values:
  `standard`, `express`, `overnight`, `pickup`.
  - This contradicts the original Phase 2a sketch which described `service`
    as free text — UI must use a `<select>` with these four options, and
    `gamma.js`'s decoder should validate against this set rather than just
    storing whatever string came in.

## 4. Listing (kind 30402) — confirmed superset

NIP-99 + Gamma's listing tag set is what MyNostr already emits in `gamma.js`.
The audit on 2026-05-08 found no missing required tags. See
`project_gamma_compliance_plan.md` in `.claude/projects/` memory for the
full audit summary.

---

## Refresh checklist (when bumping the snapshot date above)

1. Re-fetch `spec.md` from the repo above.
2. Diff the four sections in this file against the new content.
3. Update any quotes that changed; bump the date.
4. If a service-enum value or required-tag set changes, also update
   `src/lib/gammaCompliance.js` and `src/lib/gamma.js`.
