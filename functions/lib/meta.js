// Per-kind meta-tag templates. Output is the new <title> / description
// content plus a block of OG/Twitter/JSON-LD tags appended to <head>.
// All values are HTML-escaped at the boundary; callers should not need
// to worry about injection here.

import {
  escapeHtml, isSafeImageUrl, truncate, stripNoteContent,
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
  const image = isSafeImageUrl(imageRaw) ? imageRaw : DEFAULT_OG_IMAGE
  const usingDefaultImage = image === DEFAULT_OG_IMAGE

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
    // Image dimensions help validators allocate preview space and
    // suppress "missing dimensions" warnings. Only safe to declare for
    // the curated default; custom article cover images are unknown size.
    usingDefaultImage && `<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_W}" />`,
    usingDefaultImage && `<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_H}" />`,
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
  // default fallback.
  const banner  = profile?.banner
  const picture = profile?.picture
  let image, cardType, declareDimensions = false
  if (isSafeImageUrl(banner)) {
    image = banner
    cardType = 'summary_large_image'
  } else if (isSafeImageUrl(picture)) {
    image = picture
    cardType = 'summary'
  } else {
    image = DEFAULT_OG_IMAGE
    cardType = 'summary_large_image'
    declareDimensions = true
  }

  const profileUrl = npub ? `${SITE_URL}/${npub}` : canonicalUrl

  const tagLines = [
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    declareDimensions && `<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_W}" />`,
    declareDimensions && `<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_H}" />`,
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
  if (isSafeImageUrl(picture)) person.image = picture
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
