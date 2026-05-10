/**
 * NIP-15 (Nostr Marketplace) parsers — read-only.
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/15.md
 *
 * NIP-15 was the original Nostr marketplace spec, predating NIP-99 +
 * Gamma. It's still in the wild as old listings published by Sticker
 * Fund, early Plebeian Market, and Shopstr. MyNostr does NOT publish
 * NIP-15 — these parsers exist so the legacy migration tool can detect
 * a seller's pre-existing NIP-15 catalog and convert it into the modern
 * NIP-99 / Gamma format.
 *
 * Both kinds carry their payload in the event's JSON `content` blob
 * rather than tags, which is unusual for replaceable events. We parse
 * the content, validate the minimum required fields, and return a
 * normalized shape. Malformed events return null — never throw, never
 * leak partial data.
 *
 * Replaceable kinds: dedup by (kind, pubkey, dTag), keep newest by
 * created_at. Callers handle that — these parsers operate on a single
 * event at a time.
 */
export const KIND_NIP15_STALL   = 30017
export const KIND_NIP15_PRODUCT = 30018

/**
 * Parse a kind 30017 stall event into a normalized shape, or null when
 * the event is malformed. Required fields per the spec:
 *   - d-tag matching the stall id
 *   - content JSON: { id, name, currency, shipping[] }
 * Optional: description, per-zone name, regions array.
 */
export function parseStall(event) {
  if (!event || event.kind !== KIND_NIP15_STALL) return null

  const dTag = event.tags?.find(t => t[0] === 'd')?.[1] || ''
  if (!dTag) return null

  let body
  try { body = JSON.parse(event.content || 'null') } catch { return null }
  if (!body || typeof body !== 'object') return null
  if (typeof body.name !== 'string' || !body.name.trim()) return null

  // The spec says d-tag MUST equal the stall id. In practice some
  // clients drift — keep both, prefer the d-tag for addressing since
  // that's what naddrs/coords use, but surface body.id so we can
  // detect mismatches if needed.
  const id = typeof body.id === 'string' && body.id ? body.id : dTag

  const shipping = Array.isArray(body.shipping)
    ? body.shipping
        .filter(z => z && typeof z === 'object')
        .map(z => ({
          id:      typeof z.id === 'string' ? z.id : '',
          name:    typeof z.name === 'string' ? z.name.trim() : '',
          cost:    Number.isFinite(z.cost) ? z.cost : 0,
          regions: Array.isArray(z.regions)
            ? z.regions.filter(r => typeof r === 'string').map(r => r.trim()).filter(Boolean)
            : [],
        }))
    : []

  return {
    eventId:     event.id || '',
    pubkey:      event.pubkey || '',
    createdAt:   event.created_at || 0,
    dTag,
    id,
    name:        body.name.trim(),
    description: typeof body.description === 'string' ? body.description.trim() : '',
    currency:    typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '',
    shipping,
  }
}

/**
 * Parse a kind 30018 product event into a normalized shape, or null
 * when the event is malformed. Required fields per the spec:
 *   - d-tag matching the product id
 *   - content JSON: { id, stall_id, name, currency, price }
 * Optional: description, images, quantity (null = unlimited),
 * specs (key-value pairs), per-product shipping overrides, t tags.
 */
export function parseProduct(event) {
  if (!event || event.kind !== KIND_NIP15_PRODUCT) return null

  const dTag = event.tags?.find(t => t[0] === 'd')?.[1] || ''
  if (!dTag) return null

  let body
  try { body = JSON.parse(event.content || 'null') } catch { return null }
  if (!body || typeof body !== 'object') return null
  if (typeof body.name !== 'string' || !body.name.trim()) return null
  if (!Number.isFinite(body.price) || body.price < 0) return null

  const id      = typeof body.id === 'string' && body.id ? body.id : dTag
  const stallId = typeof body.stall_id === 'string' ? body.stall_id : ''

  const images = Array.isArray(body.images)
    ? body.images.filter(u => typeof u === 'string' && u.trim()).map(u => u.trim())
    : []

  // Quantity: null means unlimited per the spec; numeric values are
  // integers but we accept floats and floor (some legacy events have
  // floating point qty by mistake).
  let quantity = null
  if (body.quantity === null) quantity = null
  else if (Number.isFinite(body.quantity)) quantity = Math.max(0, Math.floor(body.quantity))

  const specs = Array.isArray(body.specs)
    ? body.specs
        .filter(p => Array.isArray(p) && p.length >= 2)
        .map(p => [String(p[0] ?? ''), String(p[1] ?? '')])
        .filter(([k, v]) => k && v)
    : []

  // Per-product shipping is *additive* over stall shipping in NIP-15.
  // We capture the raw zone+cost pairs; the migrator decides how (or
  // whether) to fold these into Gamma's flat shipping_option model.
  const shippingExtras = Array.isArray(body.shipping)
    ? body.shipping
        .filter(s => s && typeof s === 'object' && typeof s.id === 'string')
        .map(s => ({ id: s.id, cost: Number.isFinite(s.cost) ? s.cost : 0 }))
    : []

  // Free-text categories from `t` tags. NIP-15 sellers used these for
  // the same purpose as NIP-99's `t` tags; mapping is 1:1.
  const categories = (event.tags || [])
    .filter(t => t[0] === 't' && typeof t[1] === 'string')
    .map(t => t[1].trim())
    .filter(Boolean)

  return {
    eventId:     event.id || '',
    pubkey:      event.pubkey || '',
    createdAt:   event.created_at || 0,
    dTag,
    id,
    stallId,
    name:        body.name.trim(),
    description: typeof body.description === 'string' ? body.description.trim() : '',
    images,
    currency:    typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '',
    price:       body.price,
    quantity,
    specs,
    shippingExtras,
    categories,
  }
}
