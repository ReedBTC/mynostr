/**
 * Shared form helpers for the marketplace Sell composer.
 *
 * The form is the in-memory shape the composer mutates. It's a superset
 * of what the encoded kind 30402 event carries — extra fields like
 * `nsfw`, `mainCategory`, and `shippingNotes` are convenience UI slots
 * that get lowered onto the event at publish time.
 *
 * Lives in lib/ rather than the composer folder so the drafts hook,
 * import handler, and load-from-naddr handler can all share the same
 * empty-form factory + transforms without circular deps.
 */

import { titleToSlug } from './utils.js'
import { encodeProduct, decodeProduct, KIND_PRODUCT } from './gamma.js'

export function emptySellForm() {
  return {
    dTag:        '',
    title:       '',
    summary:     '',
    content:     '',
    location:    '',
    geohash:     '',
    price:       { amount: null, currency: 'SATS', frequency: '' },
    status:      'active',
    visibility:  'on-sale',
    type:        { kind: 'simple', form: 'physical' },
    stock:       null,
    weight:      '',
    dim:         '',
    tTags:       [],
    mainCategory: '',
    images:      [],
    specs:       [],
    collectionRefs: [],
    productRefs:    [],
    shippingOptionRefs: [],
    nsfw:        false,
    shippingNotes: '',
    // Advanced relay override — when enabled, publish ONLY to these
    // relays (skips the user's normal write set). Empty array + disabled
    // is the default; the publish path treats both as "no override."
    // This is form-only state; the gamma encoder doesn't emit it on the
    // event itself — it's a publish-time directive.
    relayOverride: { enabled: false, relays: [] },
    _extraTags:  [],
  }
}

// "Has the user typed anything worth saving?" — keeps fresh-empty drafts
// from being persisted indefinitely after a stray keystroke.
export function isFormMeaningful(form) {
  if (!form) return false
  if (form.title?.trim())   return true
  if (form.summary?.trim()) return true
  if (form.content?.trim()) return true
  if (Array.isArray(form.images) && form.images.some(i => i?.url)) return true
  if (Number.isFinite(form.price?.amount) && form.price.amount > 0) return true
  return false
}

// ─── Form ↔ event translations ─────────────────────────────────────────────

/**
 * Lower the form into the gamma encode shape — used both for the
 * publish path and for export-as-JSON. Extra UI fields (mainCategory,
 * nsfw, shippingNotes) are folded into the canonical event tags /
 * content here so the encoder stays a thin pass-through.
 */
export function formToGammaForm(form) {
  // Merge mainCategory into tTags as the first entry; nsfw becomes a
  // tag rather than a structured field. Dedupe so a user typing
  // "art" in mainCategory and again in tTags doesn't emit two ['t','art'].
  const tTags = []
  const seen = new Set()
  const pushTag = (t) => {
    const v = String(t || '').trim().toLowerCase()
    if (!v || seen.has(v)) return
    seen.add(v)
    tTags.push(v)
  }
  if (form.mainCategory) pushTag(form.mainCategory)
  for (const t of (form.tTags || [])) pushTag(t)
  if (form.nsfw) pushTag('nsfw')

  // Shipping notes append to the description with a heading so readers
  // see them in flow. Skipped if empty so we don't emit a bare "##
  // Shipping" with no content.
  let content = form.content || ''
  if (form.shippingNotes && form.shippingNotes.trim()) {
    const sep = content.endsWith('\n') || !content ? '' : '\n\n'
    content = `${content}${sep}\n## Shipping\n\n${form.shippingNotes.trim()}\n`
  }

  // Generate a dTag if we don't have one — slug from title plus a short
  // random suffix so two listings with the same title don't accidentally
  // overwrite each other on the author's relay set.
  let dTag = form.dTag
  if (!dTag) {
    const slug = titleToSlug(form.title) || 'listing'
    const suffix = Math.random().toString(36).slice(2, 7)
    dTag = `${slug}-${suffix}`
  }

  return { ...form, dTag, tTags, content }
}

/**
 * Build an unsigned kind 30402 event template from a form. Used for
 * JSON export — readers can sign it on import or treat it as a draft.
 * Includes pubkey when supplied so signed-event round-tripping works.
 *
 * The output also carries a `_mynostr_form` sidecar containing the full
 * form snapshot (relayOverride, mainCategory, nsfw, shippingNotes —
 * everything the composer tracks that doesn't ride on canonical event
 * tags). Other Nostr clients ignore unknown top-level keys, so the
 * event itself stays standards-compliant; mynostr-on-mynostr round-trip
 * uses the sidecar for lossless restore.
 */
export function formToEventTemplate(form, { pubkey = '' } = {}) {
  const gamma = formToGammaForm(form)
  const { kind, content, tags } = encodeProduct(gamma)
  return {
    kind,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: tags.concat([['client', 'mynostr']]),
    // Snapshot the *pre-merge* form so re-import restores the UI fields
    // (mainCategory / nsfw / shippingNotes) as separate slots rather
    // than the collapsed-into-tags/content shape gamma produces. That
    // matters because saving the gamma form would cause:
    //   • shippingNotes to be both in the field AND appended to content
    //     → double-append on next publish
    //   • nsfw to be both true AND already in tTags → duplicate t-tag
    //   • mainCategory to be empty AND first tTag → drift across saves
    // _extraTags is dropped from the sidecar — they're already in the
    // event's `tags` array and shouldn't be duplicated.
    _mynostr_form: { ...form, _extraTags: [] },
  }
}

/**
 * Decode a kind 30402 event back into a form snapshot.
 *
 * Two paths:
 *   1. mynostr-to-mynostr — when the event JSON carries a
 *      `_mynostr_form` sidecar (produced by formToEventTemplate),
 *      restore from it directly. Lossless: relayOverride, mainCategory,
 *      nsfw, shippingNotes all preserved exactly.
 *   2. Cross-client — no sidecar. Decode the event normally and
 *      heuristically restore UI fields (first t-tag → mainCategory,
 *      'nsfw' tag → nsfw flag, "## Shipping" section → shippingNotes).
 *      Lossy by design.
 *
 * Returns null if the event isn't a kind 30402 we can decode at all.
 */
export function eventToForm(event) {
  // Sidecar fast path. We still validate that the event itself decodes
  // as a 30402 — protects against a bogus sidecar attached to a wrong-
  // kind event (defensive; the import handler also validates).
  if (event && event._mynostr_form && typeof event._mynostr_form === 'object') {
    const decoded = decodeProduct(event)
    if (!decoded) return null
    // Spread over emptySellForm() so missing keys in the sidecar (older
    // exports, partial JSON) get sensible defaults rather than undefined.
    return {
      ...emptySellForm(),
      ...event._mynostr_form,
      // _extraTags are authoritative on the canonical event — pull them
      // from the gamma decode, not the sidecar (which may be stale).
      _extraTags: decoded._extraTags || [],
    }
  }

  const decoded = decodeProduct(event)
  if (!decoded) return null

  const form = emptySellForm()

  // Direct fields the gamma decoder already extracted.
  form.dTag        = decoded.dTag
  form.title       = decoded.title
  form.summary     = decoded.summary
  form.content     = decoded.content
  form.location    = decoded.location
  form.geohash     = decoded.geohash
  form.price       = {
    amount:    decoded.price.amount,
    currency:  decoded.price.currency || 'SATS',
    frequency: decoded.price.frequency,
  }
  form.status      = decoded.status     || 'active'
  form.visibility  = decoded.visibility || 'on-sale'
  form.type        = {
    kind: decoded.type.kind || 'simple',
    form: decoded.type.form || 'physical',
  }
  form.stock       = decoded.stock
  form.weight      = decoded.weight
  form.dim         = decoded.dim
  form.images      = decoded.images || []
  form.specs       = decoded.specs  || []
  form.collectionRefs    = decoded.collectionRefs    || []
  form.productRefs       = decoded.productRefs       || []
  form.shippingOptionRefs = decoded.shippingOptionRefs || []
  form._extraTags  = decoded._extraTags || []

  // ── Heuristic restoration of UI-only fields ────────────────────────
  // nsfw lives as a t-tag; pluck it out so the toggle reads correctly.
  const tTagsRaw = decoded.tTags || []
  const nsfwIdx  = tTagsRaw.findIndex(t => t === 'nsfw')
  form.nsfw = nsfwIdx >= 0
  const tTagsClean = nsfwIdx >= 0 ? tTagsRaw.filter((_, i) => i !== nsfwIdx) : tTagsRaw

  // First t-tag becomes mainCategory by convention (encoder writes it
  // first); rest stay as additional tTags.
  if (tTagsClean.length > 0) {
    form.mainCategory = tTagsClean[0]
    form.tTags = tTagsClean.slice(1)
  }

  // Detect the shipping section the encoder appends and split it back
  // out. Match the exact heading shape our encoder writes; anything
  // looser would risk truncating user-authored content that happens to
  // contain a "## Shipping" heading of its own.
  const shippingMarker = '\n## Shipping\n\n'
  const splitIdx = form.content.lastIndexOf(shippingMarker)
  if (splitIdx >= 0) {
    const body = form.content.slice(0, splitIdx).replace(/\n+$/, '')
    const ship = form.content.slice(splitIdx + shippingMarker.length).replace(/\n+$/, '')
    form.content = body
    form.shippingNotes = ship
  }

  return form
}

export { KIND_PRODUCT }
