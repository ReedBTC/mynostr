// Per-kind meta-tag templates. Output is the new <title> / description
// content plus a block of OG/Twitter/JSON-LD tags appended to <head>.
// All values are HTML-escaped at the boundary; callers should not need
// to worry about injection here.

import {
  escapeHtml, isSafeImageUrl, proxyImage, truncate, stripNoteContent,
} from './sanitize.js'

const SITE_NAME = 'MyNostr'
const SITE_URL = 'https://mynostr.app'
// JPG, not PNG — the 1200×630 PNG was 892 KB, over WhatsApp's 600 KB cap
// for og:image (image got dropped from the unfurl entirely). The JPG
// equivalent is ~370 KB, fits comfortably under every platform's limit,
// and is visually indistinguishable for a branded card.
const DEFAULT_OG_IMAGE = 'https://mynostr.app/og-default.jpg'
const DEFAULT_OG_IMAGE_W = 1200
const DEFAULT_OG_IMAGE_H = 630

const TITLE_MAX = 60
const ARTICLE_DESC_MAX = 200
// Notes get a tight cap — 140 chars rendered as 4 visual lines below
// the image on iMessage; 80 lands closer to the 2-line target. Wider
// platforms (Slack, Discord) will show a shorter preview, but that's
// preferable to the narrow case looking like a wall of text.
const NOTE_DESC_MAX = 80
// Profiles — bio (about field) is similar density to a note. Match
// the note cap so unfurls feel consistent in length.
const PROFILE_DESC_MAX = 160
// Events / listings have curated descriptions and benefit from a bit
// more room than a note (people read these to decide if they care).
const EVENT_DESC_MAX = 200
const LISTING_DESC_MAX = 200

function tagValue(event, name) {
  const t = event?.tags?.find(t => t[0] === name)
  return t?.[1] || ''
}

function profileName(profile) {
  if (!profile) return ''
  return (
    profile.display_name ||
    profile.displayName ||
    profile.name ||
    ''
  ).trim()
}

export function renderArticleMeta(event, profile, canonicalUrl) {
  const rawTitle = tagValue(event, 'title') || 'Untitled article'
  const title = truncate(rawTitle, TITLE_MAX)
  const description = truncate(
    tagValue(event, 'summary') || stripNoteContent(event.content || ''),
    ARTICLE_DESC_MAX,
  )
  const imageRaw = tagValue(event, 'image')
  // Always proxy user-supplied images so size + aspect ratio are
  // normalized for unfurlers — output is consistent 1200×630 JPG.
  const image = isSafeImageUrl(imageRaw)
    ? proxyImage(imageRaw, DEFAULT_OG_IMAGE_W, DEFAULT_OG_IMAGE_H)
    : DEFAULT_OG_IMAGE

  const publishedAtUnix = parseInt(tagValue(event, 'published_at') || '', 10)
  const isoDate = Number.isFinite(publishedAtUnix) && publishedAtUnix > 0
    ? new Date(publishedAtUnix * 1000).toISOString()
    : new Date((event.created_at || 0) * 1000).toISOString()

  const authorName = profileName(profile)
  const authorUrl = profile?.npub ? `${SITE_URL}/${profile.npub}` : SITE_URL
  const ogTitle = authorName ? `${rawTitle} — ${authorName}` : rawTitle
  const ogTitleTrimmed = truncate(ogTitle, TITLE_MAX)

  const tagLines = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(ogTitleTrimmed)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    // Always-known dimensions now: proxied images are forced to
    // 1200×630, default image is also 1200×630.
    `<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_W}" />`,
    `<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_H}" />`,
    `<meta property="article:published_time" content="${escapeHtml(isoDate)}" />`,
    authorName && `<meta property="article:author" content="${escapeHtml(authorName)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(ogTitleTrimmed)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ].filter(Boolean)

  // schema.org/Article — feeds Google's article rich-result card.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: rawTitle,
    description,
    image: [image],
    datePublished: isoDate,
    author: {
      '@type': 'Person',
      name: authorName || 'Anonymous',
      url: authorUrl,
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL,
    },
    mainEntityOfPage: canonicalUrl,
  }
  const ldScript = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`

  return {
    title: ogTitleTrimmed,
    description,
    headTags: tagLines.join('\n    ') + '\n    ' + ldScript,
  }
}

export function renderProfileMeta(profile, npub, canonicalUrl) {
  // Profile may be near-empty when the relay race didn't return a kind 0
  // (new accounts, lost events). We still render something useful — the
  // alternative is falling through to the homepage OG, which doesn't
  // identify the profile as a profile.
  const name = profileName(profile) || 'Nostr Profile'
  const nip05 = (profile?.nip05 || '').trim()
  const handle = nip05 ? `${name} (${nip05})` : name
  const title = truncate(`${handle} on ${SITE_NAME}`, TITLE_MAX)
  const description = truncate(profile?.about || '', PROFILE_DESC_MAX)

  // Banner is wider, better-suited to og:image's 1.91:1 ideal than the
  // square profile picture. Prefer banner → picture (square card) →
  // default fallback. All user-supplied images get proxied through
  // wsrv.nl so a 5 MB upload becomes a 200 KB JPG that unfurls
  // consistently — the original cause of "profile didn't load" failures.
  const banner  = profile?.banner
  const picture = profile?.picture
  let image, cardType, imageW, imageH
  if (isSafeImageUrl(banner)) {
    image = proxyImage(banner, DEFAULT_OG_IMAGE_W, DEFAULT_OG_IMAGE_H)
    cardType = 'summary_large_image'
    imageW = DEFAULT_OG_IMAGE_W
    imageH = DEFAULT_OG_IMAGE_H
  } else if (isSafeImageUrl(picture)) {
    image = proxyImage(picture, 400, 400)
    cardType = 'summary'
    imageW = 400
    imageH = 400
  } else {
    image = DEFAULT_OG_IMAGE
    cardType = 'summary_large_image'
    imageW = DEFAULT_OG_IMAGE_W
    imageH = DEFAULT_OG_IMAGE_H
  }

  const profileUrl = npub ? `${SITE_URL}/${npub}` : canonicalUrl

  const tagLines = [
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="${imageW}" />`,
    `<meta property="og:image:height" content="${imageH}" />`,
    profile?.name && `<meta property="profile:username" content="${escapeHtml(profile.name)}" />`,
    `<meta name="twitter:card" content="${cardType}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ].filter(Boolean)

  // schema.org/ProfilePage with embedded Person — Google uses this for
  // people-search results and knowledge-panel surfacing.
  const person = {
    '@type': 'Person',
    name,
    url: profileUrl,
  }
  if (description) person.description = description
  // schema.org/Person prefers a square image — feed the proxied 400×400
  // so Google's people-search surfaces don't pull a multi-megabyte raw.
  if (isSafeImageUrl(picture)) person.image = proxyImage(picture, 400, 400)
  if (nip05) person.alternateName = nip05
  if (isSafeImageUrl(profile?.website)) person.sameAs = [profile.website]

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: person,
  }
  const ldScript = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`

  return {
    title,
    description,
    headTags: tagLines.join('\n    ') + '\n    ' + ldScript,
  }
}

export function renderNoteMeta(event, profile, canonicalUrl) {
  const authorName = profileName(profile)
  const rawTitle = authorName ? `Note by ${authorName} on ${SITE_NAME}` : `Note on ${SITE_NAME}`
  const title = truncate(rawTitle, TITLE_MAX)
  const description = truncate(stripNoteContent(event.content || ''), NOTE_DESC_MAX)

  // Inline-image extraction was unreliable: notes with non-standard
  // aspect ratios (a 20:9 portrait broke iMessage layout, blanked Signal,
  // failed opengraph.xyz) gave inconsistent unfurls across platforms.
  // Without a CDN transformer to normalize dimensions, the curated
  // default image is the only thing we can guarantee renders correctly
  // everywhere — and it does (validated on iMessage, Pixel SMS, and
  // Signal mobile + desktop).
  const image = DEFAULT_OG_IMAGE

  const tagLines = [
    // og:type=website (not article) — strict validators flag the article
    // type when article:published_time + article:author aren't supplied,
    // and they don't fit kind-1 notes naturally.
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_W}" />`,
    `<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_H}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ]

  return {
    title,
    description,
    headTags: tagLines.join('\n    '),
  }
}

// ── Date helpers (events) ────────────────────────────────────────────────
//
// 31923 (time-based): start tag is a unix timestamp (string).
// 31922 (date-based, all-day): start tag is YYYY-MM-DD.
//
// Workers' Intl support is patchy across compat dates — formatting
// manually with a fixed month list dodges locale-data surprises.

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function parseEventStart(startTag, kind) {
  if (!startTag) return null
  if (kind === 31923) {
    const ts = parseInt(startTag, 10)
    if (Number.isFinite(ts) && ts > 0) return new Date(ts * 1000)
    return null
  }
  if (kind === 31922) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(startTag)) {
      return new Date(`${startTag}T00:00:00Z`)
    }
  }
  return null
}

function formatEventDate(date) {
  if (!date) return ''
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}

function formatEventStartIso(startTag, kind) {
  if (!startTag) return ''
  if (kind === 31923) {
    const ts = parseInt(startTag, 10)
    if (Number.isFinite(ts) && ts > 0) return new Date(ts * 1000).toISOString()
    return ''
  }
  if (kind === 31922) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(startTag)) return startTag
  }
  return ''
}

export function renderEventMeta(event, profile, canonicalUrl) {
  const kind = event.kind
  const rawTitle = tagValue(event, 'title') || 'Event'
  const startTag = tagValue(event, 'start')
  const endTag = tagValue(event, 'end')
  const startDate = parseEventStart(startTag, kind)
  const dateStr = formatEventDate(startDate)
  // Date in the title gives the unfurl an at-a-glance "when" without
  // needing the user to read the description.
  const titleWithDate = dateStr ? `${rawTitle} · ${dateStr}` : rawTitle
  const title = truncate(titleWithDate, TITLE_MAX)

  const description = truncate(
    tagValue(event, 'summary') || event.content || '',
    EVENT_DESC_MAX,
  )
  const imageRaw = tagValue(event, 'image')
  const image = isSafeImageUrl(imageRaw)
    ? proxyImage(imageRaw, DEFAULT_OG_IMAGE_W, DEFAULT_OG_IMAGE_H)
    : DEFAULT_OG_IMAGE

  const location = tagValue(event, 'location')
  const authorName = profileName(profile)

  const tagLines = [
    // og:type=article over the proposed og:type=event — `event` exists
    // in the Open Graph spec but is poorly supported (most unfurlers
    // ignore the type or render nothing); article is the universal
    // fallback that gives a rich card on every platform tested.
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_W}" />`,
    `<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_H}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ].filter(Boolean)

  // schema.org/Event — feeds Google's events surfaces when present.
  const startIso = formatEventStartIso(startTag, kind)
  const endIso = formatEventStartIso(endTag, kind)
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: rawTitle,
    description,
    image: [image],
  }
  if (startIso) jsonLd.startDate = startIso
  if (endIso)   jsonLd.endDate   = endIso
  if (location) jsonLd.location  = { '@type': 'Place', name: location }
  if (authorName) {
    jsonLd.organizer = {
      '@type': 'Person',
      name: authorName,
      url: profile?.npub ? `${SITE_URL}/${profile.npub}` : SITE_URL,
    }
  }
  // schema.org/Event requires an `eventStatus` and `eventAttendanceMode`
  // for full validity, but Nostr events don't carry those. Omitting is
  // valid — it just means the card won't qualify for Google's full
  // events rich-result; basic Event metadata still flows through.
  const ldScript = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`

  return {
    title,
    description,
    headTags: tagLines.join('\n    ') + '\n    ' + ldScript,
  }
}

export function renderCalendarMeta(event, profile, canonicalUrl) {
  const rawTitle = tagValue(event, 'title') || 'Calendar'
  const title = truncate(`${rawTitle} calendar on ${SITE_NAME}`, TITLE_MAX)
  const description = truncate(
    tagValue(event, 'summary') || event.content || '',
    EVENT_DESC_MAX,
  )
  const imageRaw = tagValue(event, 'image')
  const image = isSafeImageUrl(imageRaw)
    ? proxyImage(imageRaw, DEFAULT_OG_IMAGE_W, DEFAULT_OG_IMAGE_H)
    : DEFAULT_OG_IMAGE

  const tagLines = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_W}" />`,
    `<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_H}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ].filter(Boolean)

  return {
    title,
    description,
    headTags: tagLines.join('\n    '),
  }
}

// ── Listing helpers (kind 30402) ─────────────────────────────────────────

function formatPrice(priceTag) {
  // priceTag = ["price", "<amount>", "<currency>"] (currency optional)
  if (!priceTag || priceTag.length < 2) return ''
  const amount = String(priceTag[1] || '').trim()
  if (!amount) return ''
  const currency = String(priceTag[2] || '').trim().toUpperCase()
  if (currency === 'USD') return `$${amount}`
  if (currency === 'EUR') return `€${amount}`
  if (currency === 'SATS' || currency === 'SAT') return `${amount} sats`
  return currency ? `${amount} ${currency}` : amount
}

// Common ISO 4217 codes — used to gate JSON-LD offers since Google's
// Product rich-result validator rejects non-ISO codes (SATS, BTC). For
// non-ISO listings we still render the OG card with the human-readable
// price, but skip the structured offers block rather than emit invalid
// markup. This is a strict subset; expand as needed.
const ISO_4217 = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'SEK', 'NZD',
  'MXN', 'SGD', 'HKD', 'NOK', 'KRW', 'TRY', 'INR', 'RUB', 'BRL', 'ZAR',
  'PLN', 'THB', 'IDR', 'MYR', 'PHP', 'CZK', 'HUF', 'ILS', 'AED', 'SAR',
])

function firstImageTag(event) {
  // NIP-99 allows multiple ["image", url] tags. Use the first that's safe.
  const tags = event?.tags || []
  for (const t of tags) {
    if (t?.[0] === 'image' && isSafeImageUrl(t[1])) return t[1]
  }
  return ''
}

export function renderListingMeta(event, profile, canonicalUrl) {
  const rawTitle = tagValue(event, 'title') || 'Listing'
  const priceTag = (event.tags || []).find(t => t?.[0] === 'price')
  const priceStr = formatPrice(priceTag)
  // Price in the title is the strongest signal in an unfurl — "Item · $20"
  // outperforms "Item" by a wide margin in click-through.
  const titleWithPrice = priceStr ? `${rawTitle} · ${priceStr}` : rawTitle
  const title = truncate(titleWithPrice, TITLE_MAX)

  const description = truncate(
    tagValue(event, 'summary') || event.content || '',
    LISTING_DESC_MAX,
  )
  const imageRaw = firstImageTag(event)
  const image = imageRaw
    ? proxyImage(imageRaw, DEFAULT_OG_IMAGE_W, DEFAULT_OG_IMAGE_H)
    : DEFAULT_OG_IMAGE

  const authorName = profileName(profile)

  const tagLines = [
    // og:type=product is well-supported (Facebook, LinkedIn, Discord all
    // give it a "shopping" affordance; iMessage/Signal treat it as
    // article/website). Better than article for a listing.
    `<meta property="og:type" content="product" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_W}" />`,
    `<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_H}" />`,
    priceTag?.[1] && `<meta property="product:price:amount" content="${escapeHtml(priceTag[1])}" />`,
    priceTag?.[2] && `<meta property="product:price:currency" content="${escapeHtml(priceTag[2])}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ].filter(Boolean)

  // schema.org/Product. The offers block is all-or-nothing — Google's
  // validator requires `price` and `priceCurrency` (ISO 4217) on every
  // Offer; partial Offers with just availability/seller fail validation.
  //
  // For non-ISO currencies (SATS, BTC) we ship Product without offers
  // entirely. The OG card still shows the human-readable price
  // ("5000 sats") for the unfurl preview — we just don't claim
  // structured price data Google can't validate. USD/EUR/etc.
  // listings get the full Offer with availability + seller + price.
  //
  // Other optional warnings we accept:
  //   - shippingDetails / hasMerchantReturnPolicy — NIP-99 doesn't
  //     carry structured shipping/return data, and fabricating
  //     "free shipping" or "no returns" defaults would misrepresent
  //     sellers whose actual policies vary per listing.
  //   - brand / gtin — Nostr's individual-seller model doesn't fit
  //     branded-retail identifiers; Person-as-brand bends the schema.
  // schema.org/Product validation is all-or-nothing: it requires one of
  // offers/review/aggregateRating, and offers itself requires ISO 4217
  // price + priceCurrency. We have potential for offers (when the
  // currency is ISO) but never reviews or aggregate ratings — no
  // honest source for those on a Nostr listing.
  //
  // Result: only ISO-priced listings get JSON-LD. SATS/BTC listings
  // ship zero structured data — Google indexes them as regular pages
  // (no rich-result treatment, but no errors either), and the OG card
  // continues to drive social unfurls regardless.
  const currencyCode = String(priceTag?.[2] || '').trim().toUpperCase()
  const hasIsoPrice = ISO_4217.has(currencyCode) && !!priceTag?.[1]
  const status = tagValue(event, 'status')

  let ldScript = ''
  if (hasIsoPrice) {
    const offer = {
      '@type': 'Offer',
      price: priceTag[1],
      priceCurrency: currencyCode,
    }
    if (status === 'sold')   offer.availability = 'https://schema.org/SoldOut'
    if (status === 'active') offer.availability = 'https://schema.org/InStock'
    if (authorName) {
      offer.seller = {
        '@type': 'Person',
        name: authorName,
        url: profile?.npub ? `${SITE_URL}/${profile.npub}` : SITE_URL,
      }
    }
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: rawTitle,
      description,
      image: [image],
      offers: offer,
    }
    ldScript = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
  }

  return {
    title,
    description,
    headTags: tagLines.join('\n    ') + (ldScript ? '\n    ' + ldScript : ''),
  }
}
