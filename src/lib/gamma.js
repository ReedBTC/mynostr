/**
 * Gamma Markets — encoder/decoder for the marketplace event kinds we use.
 *
 * Spec lineage (deliberate, not arbitrary):
 *   • Kind 30402 — NIP-99 classified listing (the canonical, broadly read
 *     primitive). Stock NIP-99 readers see our listings without any Gamma
 *     awareness; Plebeian + other Gamma-aware clients pick up the extra
 *     structure via the additional tags below.
 *   • Kind 30405 — Gamma collection. Generic "list of product refs" used
 *     for both seller-side product grouping ("Holiday Specials") and the
 *     buyer-side watchlist (a single per-user 30405 with d:watchlist).
 *   • Kind 30406 — Gamma shipping option. Power-user reusable shipping
 *     rule referenced from products / collections.
 *
 * Authoritative spec: https://github.com/GammaMarkets/market-spec
 *
 * ── Round-trip philosophy ─────────────────────────────────────────────
 * The decoder preserves *all* tags it doesn't recognise as a flat array
 * on `_extraTags`. The encoder re-emits them when given. That keeps us
 * forward-compatible with future Gamma additions (or other clients'
 * sidecar tags) so editing a listing through MyNostr never strips
 * fields we don't yet understand.
 */

export const KIND_PRODUCT          = 30402
export const KIND_PRODUCT_INACTIVE = 30403  // NIP-99 draft/inactive — relay-side, not used by alpha
export const KIND_COLLECTION       = 30405
export const KIND_SHIPPING_OPTION  = 30406

// Watchlist convention: one collection per user with a fixed d-tag, so
// the rest of the app can find a user's watchlist without a name lookup.
// Other collections use UUIDs / user-chosen slugs.
export const WATCHLIST_D_TAG = 'watchlist'

const PRODUCT_VISIBILITY_VALUES = new Set(['hidden', 'on-sale', 'pre-order'])
const PRODUCT_STATUS_VALUES     = new Set(['active', 'sold'])
const PRODUCT_TYPE_KIND_VALUES  = new Set(['simple', 'variable', 'variation'])
const PRODUCT_TYPE_FORM_VALUES  = new Set(['digital', 'physical'])

// Tags we *do* understand and consume into the decoded form. Anything not
// in this set is preserved verbatim on `_extraTags` for round-trip.
const PRODUCT_KNOWN_TAGS = new Set([
  'd', 'title', 'summary', 'published_at', 'location',
  'price', 'status', 't', 'image', 'g', 'type', 'visibility',
  'stock', 'spec', 'weight', 'dim', 'a', 'shipping_option',
])
const COLLECTION_KNOWN_TAGS = new Set([
  'd', 'title', 'summary', 'image', 'location', 'g', 'a', 'shipping_option', 't',
])
const SHIPPING_KNOWN_TAGS = new Set([
  'd', 'title', 'price', 'country', 'region', 'service', 'carrier',
  'duration', 'weight-min', 'weight-max', 'dim-min', 'dim-max',
  'price-weight', 'price-volume', 'price-distance', 'location', 'g', 't',
])

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickFirst(tags, name) {
  return tags?.find(t => t[0] === name)
}
function pickFirstValue(tags, name) {
  return pickFirst(tags, name)?.[1] || ''
}
function pickAll(tags, name) {
  return (tags || []).filter(t => t[0] === name)
}
function pickAllValues(tags, name) {
  return pickAll(tags, name).map(t => t[1]).filter(Boolean)
}

// String → number with bounds. Rejects NaN and negative-where-illegal.
// Returns null on failure so caller can decide between "field missing"
// (null) and "field intentionally zero" (0).
function parseNumberOrNull(s, { allowNegative = false } = {}) {
  if (s === undefined || s === null || s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  if (!allowNegative && n < 0) return null
  return n
}

// ─── Kind 30402 — Product ───────────────────────────────────────────────────

/**
 * Decode a kind 30402 event into the form-friendly shape consumed by the
 * Sell composer / product views.
 *
 * Returns null if `event` is missing or wrong kind.
 *
 * Decoded shape:
 *   {
 *     pubkey, dTag, createdAt,
 *     title, summary, content (markdown body),
 *     publishedAt (number | null),
 *     location, geohash,
 *     price: { amount: number|null, currency: string, frequency: string },
 *     status: 'active' | 'sold' | '',     // NIP-99 status
 *     visibility: 'on-sale' | 'hidden' | 'pre-order' | '',  // Gamma
 *     type: { kind: 'simple'|'variable'|'variation'|'', form: 'digital'|'physical'|'' },
 *     stock: number | null,
 *     weight: string,    // raw value — Gamma allows unit suffix; we don't reformat
 *     dim:    string,
 *     tTags:    string[],
 *     images:   { url, dims, sort }[],   // sort is a number when supplied
 *     specs:    { key, value }[],
 *     collectionRefs: string[],          // values of "a" tags pointing at 30405s
 *     productRefs:    string[],          // for kind=variation, values of "a" tags pointing at parent 30402
 *     shippingOptionRefs: { ref, extraCost }[],  // a-coords pointing at 30406 or 30405
 *     _extraTags: tag[][],
 *   }
 */
export function decodeProduct(event) {
  if (!event || event.kind !== KIND_PRODUCT) return null
  const tags = event.tags || []

  // Split the multi-value `type` tag into kind+form. Gamma puts both in
  // a single tag; either or both may be missing on legacy NIP-99 events.
  const typeTag = pickFirst(tags, 'type') || []
  const type = { kind: '', form: '' }
  for (let i = 1; i < typeTag.length; i++) {
    const v = String(typeTag[i] || '').toLowerCase()
    if (PRODUCT_TYPE_KIND_VALUES.has(v))      type.kind = v
    else if (PRODUCT_TYPE_FORM_VALUES.has(v)) type.form = v
  }

  // `price` is `[amount, currency, frequency]`. NIP-99 makes amount + currency
  // required when the tag is present; frequency is optional.
  const priceTag = pickFirst(tags, 'price') || []
  const price = {
    amount:    parseNumberOrNull(priceTag[1]),
    currency:  String(priceTag[2] || '').toUpperCase(),
    frequency: String(priceTag[3] || ''),
  }

  // Image tags can be Gamma-extended `["image", url, dims, sort]` or stock
  // NIP-99 `["image", url]`. We accept both; missing fields decode to ''.
  const images = pickAll(tags, 'image').map(t => ({
    url:  t[1] || '',
    dims: t[2] || '',
    sort: parseNumberOrNull(t[3]),
  })).filter(img => img.url)

  // Spec tags are repeatable `["spec", key, value]` pairs.
  const specs = pickAll(tags, 'spec').map(t => ({
    key:   t[1] || '',
    value: t[2] || '',
  })).filter(s => s.key)

  // `a` tags split: refs at 30405:* are collection memberships; refs at
  // 30402:* are parent-product refs (variation kind). Anything else
  // falls through to _extraTags so we don't accidentally lose it.
  const collectionRefs = []
  const productRefs    = []
  const aLeftovers     = []
  for (const t of pickAll(tags, 'a')) {
    const v = t[1] || ''
    if (v.startsWith(`${KIND_COLLECTION}:`))   collectionRefs.push(v)
    else if (v.startsWith(`${KIND_PRODUCT}:`)) productRefs.push(v)
    else aLeftovers.push(t)
  }

  // Shipping option refs preserve the optional extra-cost field.
  const shippingOptionRefs = pickAll(tags, 'shipping_option').map(t => ({
    ref:       t[1] || '',
    extraCost: parseNumberOrNull(t[2]),
  })).filter(s => s.ref)

  const visibilityRaw = pickFirstValue(tags, 'visibility').toLowerCase()
  const statusRaw     = pickFirstValue(tags, 'status').toLowerCase()

  // Anything we recognise as "known" is consumed into the structured
  // shape above; "a" tags are special-cased into collectionRefs /
  // productRefs / aLeftovers earlier in this function. Everything else
  // rides through verbatim on _extraTags for round-trip preservation.
  const extraTags = tags
    .filter(t => !PRODUCT_KNOWN_TAGS.has(t[0]))
    .concat(aLeftovers)

  return {
    pubkey:      event.pubkey || '',
    dTag:        pickFirstValue(tags, 'd'),
    createdAt:   event.created_at || 0,
    title:       pickFirstValue(tags, 'title'),
    summary:     pickFirstValue(tags, 'summary'),
    content:     event.content || '',
    publishedAt: parseNumberOrNull(pickFirstValue(tags, 'published_at')),
    location:    pickFirstValue(tags, 'location'),
    geohash:     pickFirstValue(tags, 'g'),
    price,
    status:      PRODUCT_STATUS_VALUES.has(statusRaw) ? statusRaw : '',
    visibility:  PRODUCT_VISIBILITY_VALUES.has(visibilityRaw) ? visibilityRaw : '',
    type,
    stock:       parseNumberOrNull(pickFirstValue(tags, 'stock')),
    weight:      pickFirstValue(tags, 'weight'),
    dim:         pickFirstValue(tags, 'dim'),
    tTags:       pickAllValues(tags, 't'),
    images,
    specs,
    collectionRefs,
    productRefs,
    shippingOptionRefs,
    _extraTags:  extraTags,
  }
}

/**
 * Encode a product form into a partial Nostr event ready to be signed.
 * Returns `{ kind, content, tags }` — caller adds `pubkey`, `created_at`,
 * `id`, `sig` via the signer.
 *
 * Required fields per NIP-99: dTag, title, summary, location.
 * `published_at` is auto-filled with `now` if absent.
 *
 * Throws on missing required fields rather than silently emitting an
 * incomplete event — bad listings poison search relays for everyone.
 */
export function encodeProduct(form) {
  const errors = []
  if (!form?.dTag)     errors.push('dTag is required')
  if (!form?.title)    errors.push('title is required')
  if (!form?.summary && !form?.content) errors.push('summary or content is required')
  if (errors.length) throw new Error(`encodeProduct: ${errors.join('; ')}`)

  const tags = []
  tags.push(['d',     form.dTag])
  tags.push(['title', form.title])
  if (form.summary) tags.push(['summary', form.summary])
  // NIP-99 makes location required, but a sensible "" works for digital
  // goods; we emit the tag either way so readers know it was considered.
  tags.push(['location', form.location || ''])

  const publishedAt = form.publishedAt || Math.floor(Date.now() / 1000)
  tags.push(['published_at', String(publishedAt)])

  if (form.geohash) tags.push(['g', form.geohash])

  // Price: only emit when amount supplied. Currency defaults to SATS for
  // a Bitcoin-native default; callers should override for fiat-priced
  // listings. Frequency is optional and rarely useful for goods.
  if (form.price && form.price.amount !== null && form.price.amount !== undefined) {
    const amount   = String(form.price.amount)
    const currency = (form.price.currency || 'SATS').toUpperCase()
    if (form.price.frequency) tags.push(['price', amount, currency, form.price.frequency])
    else                      tags.push(['price', amount, currency])
  }

  if (PRODUCT_STATUS_VALUES.has(form.status))         tags.push(['status', form.status])
  if (PRODUCT_VISIBILITY_VALUES.has(form.visibility)) tags.push(['visibility', form.visibility])

  // Type tag: emit as `["type", kind, form]` when at least one is set.
  if (form.type && (form.type.kind || form.type.form)) {
    const parts = ['type']
    if (form.type.kind && PRODUCT_TYPE_KIND_VALUES.has(form.type.kind)) parts.push(form.type.kind)
    if (form.type.form && PRODUCT_TYPE_FORM_VALUES.has(form.type.form)) parts.push(form.type.form)
    if (parts.length > 1) tags.push(parts)
  }

  if (form.stock !== null && form.stock !== undefined) tags.push(['stock', String(form.stock)])
  if (form.weight) tags.push(['weight', form.weight])
  if (form.dim)    tags.push(['dim',    form.dim])

  for (const t of (form.tTags || [])) {
    const v = String(t || '').trim()
    if (v) tags.push(['t', v])
  }

  for (const img of (form.images || [])) {
    if (!img?.url) continue
    const parts = ['image', img.url]
    if (img.dims) parts.push(img.dims)
    if (img.sort !== null && img.sort !== undefined) parts.push(String(img.sort))
    tags.push(parts)
  }

  for (const s of (form.specs || [])) {
    if (!s?.key) continue
    tags.push(['spec', s.key, String(s.value ?? '')])
  }

  for (const ref of (form.collectionRefs || [])) {
    if (ref) tags.push(['a', ref])
  }
  for (const ref of (form.productRefs || [])) {
    if (ref) tags.push(['a', ref])
  }

  for (const s of (form.shippingOptionRefs || [])) {
    if (!s?.ref) continue
    if (s.extraCost !== null && s.extraCost !== undefined) {
      tags.push(['shipping_option', s.ref, String(s.extraCost)])
    } else {
      tags.push(['shipping_option', s.ref])
    }
  }

  // Round-trip preservation — anything we didn't recognise on decode flows
  // back through here untouched.
  for (const t of (form._extraTags || [])) {
    if (Array.isArray(t) && t.length > 0) tags.push(t)
  }

  return {
    kind:    KIND_PRODUCT,
    content: form.content || '',
    tags,
  }
}

// ─── Kind 30405 — Collection ────────────────────────────────────────────────

/**
 * Decoded collection shape:
 *   {
 *     pubkey, dTag, createdAt,
 *     title, summary, image, location, geohash,
 *     productRefs: string[],          // "30402:pubkey:dtag"
 *     shippingOptionRefs: { ref, extraCost }[],
 *     tTags: string[],
 *     _extraTags: tag[][],
 *   }
 */
export function decodeCollection(event) {
  if (!event || event.kind !== KIND_COLLECTION) return null
  const tags = event.tags || []

  const productRefs = []
  const aLeftovers  = []
  for (const t of pickAll(tags, 'a')) {
    const v = t[1] || ''
    if (v.startsWith(`${KIND_PRODUCT}:`)) productRefs.push(v)
    else aLeftovers.push(t)
  }

  const shippingOptionRefs = pickAll(tags, 'shipping_option').map(t => ({
    ref:       t[1] || '',
    extraCost: parseNumberOrNull(t[2]),
  })).filter(s => s.ref)

  // Same pattern as decodeProduct — known tags are consumed above,
  // unknown ones round-trip via _extraTags so editing through MyNostr
  // doesn't strip fields we don't understand.
  const extraTags = tags
    .filter(t => !COLLECTION_KNOWN_TAGS.has(t[0]))
    .concat(aLeftovers)

  return {
    pubkey:    event.pubkey || '',
    dTag:      pickFirstValue(tags, 'd'),
    createdAt: event.created_at || 0,
    title:     pickFirstValue(tags, 'title'),
    summary:   pickFirstValue(tags, 'summary'),
    image:     pickFirstValue(tags, 'image'),
    location:  pickFirstValue(tags, 'location'),
    geohash:   pickFirstValue(tags, 'g'),
    productRefs,
    shippingOptionRefs,
    tTags:     pickAllValues(tags, 't'),
    _extraTags: extraTags,
  }
}

export function encodeCollection(form) {
  if (!form?.dTag)  throw new Error('encodeCollection: dTag is required')
  if (!form?.title) throw new Error('encodeCollection: title is required')
  const tags = []
  tags.push(['d',     form.dTag])
  tags.push(['title', form.title])
  if (form.summary)  tags.push(['summary',  form.summary])
  if (form.image)    tags.push(['image',    form.image])
  if (form.location) tags.push(['location', form.location])
  if (form.geohash)  tags.push(['g',        form.geohash])
  for (const t of (form.tTags || [])) {
    const v = String(t || '').trim()
    if (v) tags.push(['t', v])
  }
  for (const ref of (form.productRefs || [])) {
    if (ref) tags.push(['a', ref])
  }
  for (const s of (form.shippingOptionRefs || [])) {
    if (!s?.ref) continue
    if (s.extraCost !== null && s.extraCost !== undefined) {
      tags.push(['shipping_option', s.ref, String(s.extraCost)])
    } else {
      tags.push(['shipping_option', s.ref])
    }
  }
  for (const t of (form._extraTags || [])) {
    if (Array.isArray(t) && t.length > 0) tags.push(t)
  }
  return { kind: KIND_COLLECTION, content: form.content || '', tags }
}

// ─── Kind 30406 — Shipping option ──────────────────────────────────────────

/**
 * Decoded shipping option shape (only the fields we use in alpha — extras
 * land on _extraTags). Geohash is `g`; `country` is repeatable ISO codes.
 */
export function decodeShippingOption(event) {
  if (!event || event.kind !== KIND_SHIPPING_OPTION) return null
  const tags = event.tags || []

  const priceTag = pickFirst(tags, 'price') || []
  const price = {
    amount:   parseNumberOrNull(priceTag[1]),
    currency: String(priceTag[2] || '').toUpperCase(),
  }

  const extraTags = tags.filter(t => !SHIPPING_KNOWN_TAGS.has(t[0]))

  return {
    pubkey:    event.pubkey || '',
    dTag:      pickFirstValue(tags, 'd'),
    createdAt: event.created_at || 0,
    title:     pickFirstValue(tags, 'title'),
    price,
    countries: pickAllValues(tags, 'country'),
    regions:   pickAllValues(tags, 'region'),
    service:   pickFirstValue(tags, 'service'),
    carrier:   pickFirstValue(tags, 'carrier'),
    location:  pickFirstValue(tags, 'location'),
    geohash:   pickFirstValue(tags, 'g'),
    tTags:     pickAllValues(tags, 't'),
    _extraTags: extraTags,
  }
}

export function encodeShippingOption(form) {
  if (!form?.dTag)  throw new Error('encodeShippingOption: dTag is required')
  if (!form?.title) throw new Error('encodeShippingOption: title is required')
  const tags = []
  tags.push(['d',     form.dTag])
  tags.push(['title', form.title])
  if (form.price && form.price.amount !== null && form.price.amount !== undefined) {
    tags.push(['price', String(form.price.amount), (form.price.currency || 'SATS').toUpperCase()])
  }
  for (const c of (form.countries || [])) if (c) tags.push(['country', c])
  for (const r of (form.regions   || [])) if (r) tags.push(['region',  r])
  if (form.service)  tags.push(['service',  form.service])
  if (form.carrier)  tags.push(['carrier',  form.carrier])
  if (form.location) tags.push(['location', form.location])
  if (form.geohash)  tags.push(['g',        form.geohash])
  for (const t of (form.tTags || [])) {
    const v = String(t || '').trim()
    if (v) tags.push(['t', v])
  }
  for (const t of (form._extraTags || [])) {
    if (Array.isArray(t) && t.length > 0) tags.push(t)
  }
  return { kind: KIND_SHIPPING_OPTION, content: form.content || '', tags }
}

// ─── Address-coord helpers ─────────────────────────────────────────────────
// Gamma + NIP-19 use `kind:pubkey:dtag` for addressable references. These
// helpers keep the format consistent across the marketplace module.

export function buildProductCoord(pubkey, dTag) {
  if (!pubkey || !dTag) return ''
  return `${KIND_PRODUCT}:${pubkey}:${dTag}`
}
export function buildCollectionCoord(pubkey, dTag) {
  if (!pubkey || !dTag) return ''
  return `${KIND_COLLECTION}:${pubkey}:${dTag}`
}
export function buildShippingCoord(pubkey, dTag) {
  if (!pubkey || !dTag) return ''
  return `${KIND_SHIPPING_OPTION}:${pubkey}:${dTag}`
}

// Parse a coord into its parts, or null if malformed. dTag may itself
// contain colons (per NIP-01), so we slice from the second colon on.
export function parseCoord(coord) {
  if (!coord || typeof coord !== 'string') return null
  const firstColon  = coord.indexOf(':')
  const secondColon = coord.indexOf(':', firstColon + 1)
  if (firstColon < 0 || secondColon < 0) return null
  const kind   = Number(coord.slice(0, firstColon))
  const pubkey = coord.slice(firstColon + 1, secondColon)
  const dTag   = coord.slice(secondColon + 1)
  if (!Number.isInteger(kind) || !pubkey) return null
  return { kind, pubkey, dTag }
}
