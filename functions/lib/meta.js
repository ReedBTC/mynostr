// Per-kind meta-tag templates. Output is the new <title> / description
// content plus a block of OG/Twitter/JSON-LD tags appended to <head>.
// All values are HTML-escaped at the boundary; callers should not need
// to worry about injection here.

import {
  escapeHtml, isSafeImageUrl, truncate,
  stripNoteContent, extractFirstImage,
} from './sanitize.js'

const SITE_NAME = 'MyNostr'
const SITE_URL = 'https://mynostr.app'
const DEFAULT_OG_IMAGE = 'https://mynostr.app/og-default.png'

const TITLE_MAX = 60
const DESC_MAX = 200

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
    DESC_MAX,
  )
  const imageRaw = tagValue(event, 'image')
  const image = isSafeImageUrl(imageRaw) ? imageRaw : DEFAULT_OG_IMAGE

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

export function renderNoteMeta(event, profile, canonicalUrl) {
  const authorName = profileName(profile)
  const rawTitle = authorName ? `Note by ${authorName} on ${SITE_NAME}` : `Note on ${SITE_NAME}`
  const title = truncate(rawTitle, TITLE_MAX)
  const description = truncate(stripNoteContent(event.content || ''), DESC_MAX)

  const inlineImage = extractFirstImage(event.content || '')
  const hasInlineImage = isSafeImageUrl(inlineImage)
  const image = hasInlineImage ? inlineImage : DEFAULT_OG_IMAGE
  // Big card only when the note actually has a visual; otherwise the
  // small `summary` card looks better with the static fallback image.
  const cardType = hasInlineImage ? 'summary_large_image' : 'summary'

  const tagLines = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta name="twitter:card" content="${cardType}" />`,
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
