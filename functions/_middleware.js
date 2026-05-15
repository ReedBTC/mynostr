// Cloudflare Pages Function — OG / Twitter / JSON-LD enrichment for
// shared mynostr.app entity URLs. Runs ahead of the static-asset
// handler. For shareable URLs (article / note share targets in phase 1),
// fetches the underlying Nostr event from a small relay set, renders
// meta tags, and injects them into the SPA's index.html via HTMLRewriter.
// All other URLs pass through untouched.
//
// Failure modes are deliberately fail-open — any error in detection,
// fetch, or transform falls through to the static asset. Site
// availability is more important than rich previews; a relay outage
// must NOT take mynostr.app down.

import { nip19 } from 'nostr-tools'
import { raceRelays } from './lib/relays.js'
import {
  renderArticleMeta, renderNoteMeta, renderProfileMeta,
  renderEventMeta, renderCalendarMeta, renderListingMeta,
} from './lib/meta.js'

const SITE_ORIGIN = 'https://mynostr.app'
const CACHE_TTL_SECONDS = 3600
// Bump to invalidate every existing cached entry. Use this when meta-tag
// templates change so old previews don't linger for the TTL window after
// a deploy. Keys live under a synthetic origin so the bump is transparent
// to the request URL itself.
const CACHE_VERSION = 'v11'

export async function onRequest(context) {
  const { request, next } = context

  // Only enrich GET. Anything else (HEAD, OPTIONS) flows through.
  if (request.method !== 'GET') return next()

  const url = new URL(request.url)

  // Quick gate — if the path looks like a static asset (has an extension
  // on the final segment), skip the function entirely. Avoids paying the
  // detection cost on every JS/CSS/image request.
  const lastSeg = url.pathname.split('/').pop() || ''
  if (lastSeg.includes('.')) return next()

  let detection
  try {
    detection = detectEntity(url)
  } catch {
    return next()
  }
  if (!detection) return next()

  // Cache lookup — keyed on the normalized request URL. 1h TTL means an
  // edited article's preview can be stale for up to an hour; unfurlers
  // typically grab once per share so this is acceptable.
  const cache = caches.default
  const cacheKey = new Request(
    `https://og-cache.mynostr.app/${CACHE_VERSION}${url.pathname}${url.search}`,
    { method: 'GET' },
  )
  try {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  } catch {}

  // Fetch + render. Anything that throws → fall through to static.
  let meta
  try {
    meta = await fetchAndRender(detection, url.toString())
  } catch {
    return next()
  }
  if (!meta) return next()

  // Get the static index.html, transform it, materialize, cache, return.
  const original = await next()
  const ct = original.headers.get('content-type') || ''
  if (!ct.includes('text/html')) return original

  let final
  try {
    final = await transformAndMaterialize(original, meta)
  } catch {
    return next()
  }

  context.waitUntil(cache.put(cacheKey, final.clone()).catch(() => {}))
  return final
}

// ── URL → entity detection ──────────────────────────────────────────────────
//
// Phase 2: articles (kind 30023), notes (kind 1), profiles (kind 0).
// Events / listings / other naddr kinds still pass through.
//
// Recognized URL shapes (both bech32-shortform and canonical app URLs):
//   /naddr1...                              — article, IF kind === 30023
//   /nevent1..., /note1...                  — note
//   /npub1..., /nprofile1...                — profile
//   /<npub>/articles?article=<naddr>        — article (canonical)
//   /<npub>/notes/<nevent|note>             — note (canonical)
//   /<npub>/...                             — profile (catch-all for any
//                                             other route under an npub)
//
function detectEntity(url) {
  const path = url.pathname
  const search = url.searchParams

  // ── Bech32 single-segment routes (BechResolver targets) ──
  const naddrPath = /^\/(naddr1[a-z0-9]+)\/?$/i.exec(path)
  if (naddrPath) {
    const decoded = safeDecode(naddrPath[1])
    if (decoded?.type === 'naddr') {
      const k = decoded.data.kind
      if (k === 30023 || k === 31922 || k === 31923 || k === 31924 || k === 30402) {
        return { kind: k, pubkey: decoded.data.pubkey, dTag: decoded.data.identifier }
      }
    }
    return null
  }

  const neventPath = /^\/(nevent1[a-z0-9]+|note1[a-z0-9]+)\/?$/i.exec(path)
  if (neventPath) {
    const decoded = safeDecode(neventPath[1])
    if (decoded?.type === 'nevent') {
      return { kind: 1, eventId: decoded.data.id, pubkey: decoded.data.author || null }
    }
    if (decoded?.type === 'note') {
      return { kind: 1, eventId: decoded.data, pubkey: null }
    }
    return null
  }

  const npubBech = /^\/(npub1[a-z0-9]+)\/?$/i.exec(path)
  if (npubBech) {
    const decoded = safeDecode(npubBech[1])
    if (decoded?.type === 'npub') return { kind: 0, pubkey: decoded.data }
    return null
  }

  const nprofileBech = /^\/(nprofile1[a-z0-9]+)\/?$/i.exec(path)
  if (nprofileBech) {
    const decoded = safeDecode(nprofileBech[1])
    if (decoded?.type === 'nprofile') return { kind: 0, pubkey: decoded.data.pubkey }
    return null
  }

  // ── Canonical app URLs starting with /<npub>/... ──
  // The npub catch-all sits at the end so article/note detail patterns
  // get first refusal. Anything else under /<npub>/ falls through to a
  // profile share — landing on /<npub>/notes shouldn't unfurl with
  // generic homepage meta.
  const npubPrefix = /^\/(npub1[a-z0-9]+)(\/.*)?$/i.exec(path)
  if (npubPrefix) {
    const npubStr = npubPrefix[1]
    const rest = npubPrefix[2] || ''

    // Article share: /<npub>/articles[/<subtab>]?article=<naddr>
    const articleSegment = /^\/articles(?:\/[a-z]+)?\/?$/i.test(rest)
    if (articleSegment) {
      const naddrParam = search.get('article')
      if (naddrParam) {
        const decoded = safeDecode(naddrParam)
        if (decoded?.type === 'naddr' && decoded.data.kind === 30023) {
          return { kind: 30023, pubkey: decoded.data.pubkey, dTag: decoded.data.identifier }
        }
      }
      // No ?article= param → falls through to profile catch-all below.
    }

    // Note detail: /<npub>/notes/<nevent|note>
    const noteDetail = /^\/notes\/(nevent1[a-z0-9]+|note1[a-z0-9]+)\/?$/i.exec(rest)
    if (noteDetail) {
      const decoded = safeDecode(noteDetail[1])
      if (decoded?.type === 'nevent') {
        return { kind: 1, eventId: decoded.data.id, pubkey: decoded.data.author || null }
      }
      if (decoded?.type === 'note') {
        return { kind: 1, eventId: decoded.data, pubkey: null }
      }
      return null
    }

    // Event detail: /<npub>/events/<naddr>. Falls through to profile
    // catch-all on malformed naddr — better than null since the user
    // shared a /<npub>/... URL and a profile card is still useful.
    const eventDetail = /^\/events\/(naddr1[a-z0-9]+)\/?$/i.exec(rest)
    if (eventDetail) {
      const decoded = safeDecode(eventDetail[1])
      if (decoded?.type === 'naddr') {
        const k = decoded.data.kind
        if (k === 31922 || k === 31923 || k === 31924) {
          return { kind: k, pubkey: decoded.data.pubkey, dTag: decoded.data.identifier }
        }
      }
      // Falls through to profile catch-all
    }

    // Calendar detail: /<npub>/events/cal-<dTag>. The "cal-" prefix is
    // a routing marker the SPA uses to distinguish calendar shares from
    // event shares; pubkey comes from the npub in the URL.
    const calendarDetail = /^\/events\/cal-(.+?)\/?$/i.exec(rest)
    if (calendarDetail) {
      const dTag = decodeURIComponent(calendarDetail[1])
      const decoded = safeDecode(npubStr)
      if (decoded?.type === 'npub' && dTag) {
        return { kind: 31924, pubkey: decoded.data, dTag }
      }
      // Falls through to profile catch-all
    }

    // Marketplace listing: /<npub>/marketplace?listing=<naddr>
    const marketplaceSegment = /^\/marketplace\/?$/i.test(rest)
    if (marketplaceSegment) {
      const naddrParam = search.get('listing')
      if (naddrParam) {
        const decoded = safeDecode(naddrParam)
        if (decoded?.type === 'naddr' && decoded.data.kind === 30402) {
          return { kind: 30402, pubkey: decoded.data.pubkey, dTag: decoded.data.identifier }
        }
      }
      // No ?listing= or malformed → falls through to profile catch-all.
    }

    // Profile catch-all — bare /<npub>, /<npub>/notes, /<npub>/articles,
    // /<npub>/events, etc. Any module surface someone shares should
    // unfurl as the user's profile (rather than the homepage).
    const decoded = safeDecode(npubStr)
    if (decoded?.type === 'npub') return { kind: 0, pubkey: decoded.data }
    return null
  }

  return null
}

function safeDecode(bech) {
  try { return nip19.decode(bech) } catch { return null }
}

// ── Fetch + render ─────────────────────────────────────────────────────────

async function fetchAndRender(detection, requestUrl) {
  const { kind, pubkey, dTag, eventId } = detection

  // ── Profile (kind 0) ──
  // Single fetch. Profile-not-found is allowed to render — degraded card
  // beats falling through to the homepage OG, which doesn't identify
  // the share as a profile at all.
  if (kind === 0) {
    if (!pubkey) return null
    const profileEvent = await raceRelays({ kinds: [0], authors: [pubkey], limit: 1 })
    let profile = { pubkey }
    if (profileEvent) {
      try {
        profile = { ...JSON.parse(profileEvent.content), pubkey }
      } catch {}
    }
    let npub = ''
    try { npub = nip19.npubEncode(pubkey) } catch {}
    profile.npub = npub
    const canonicalUrl = npub ? `${SITE_ORIGIN}/${npub}` : requestUrl
    return renderProfileMeta(profile, npub, canonicalUrl)
  }

  // ── Articles, notes, events, calendars, listings ──
  // Build the event filter. Replaceables (30023, 31922/3/4, 30402) all
  // share the (kind, author, d-tag) lookup pattern. Notes are by id.
  let filter
  if (kind === 30023 || kind === 31922 || kind === 31923 || kind === 31924 || kind === 30402) {
    if (!pubkey || !dTag) return null
    filter = { kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 }
  } else if (kind === 1 && eventId) {
    filter = { ids: [eventId], limit: 1 }
  } else {
    return null
  }

  // Race profile fetch in parallel when we know the author up-front.
  // Skipping the second fetch on note-by-id (no author hint) keeps
  // worst-case latency bounded to one race window — the note still
  // unfurls, just with a generic "Note on MyNostr" title.
  const eventPromise = raceRelays(filter)
  const profilePromise = pubkey
    ? raceRelays({ kinds: [0], authors: [pubkey], limit: 1 })
    : Promise.resolve(null)

  const [event, profileEvent] = await Promise.all([eventPromise, profilePromise])
  if (!event) return null

  let profile = null
  if (profileEvent) {
    try {
      const data = JSON.parse(profileEvent.content)
      profile = {
        ...data,
        pubkey: profileEvent.pubkey,
        npub: nip19.npubEncode(profileEvent.pubkey),
      }
    } catch {}
  }

  // Build the canonical share URL we'll use for og:url. For replaceables
  // the canonical form is the bech32 naddr (stable across npub changes).
  // For notes we mirror whatever the request URL was — that's what the
  // user shared, and unfurlers should see it back.
  let canonicalUrl = requestUrl
  if (kind === 30023 || kind === 31922 || kind === 31923 || kind === 31924 || kind === 30402) {
    try {
      const naddr = nip19.naddrEncode({ kind, pubkey, identifier: dTag })
      canonicalUrl = `${SITE_ORIGIN}/${naddr}`
    } catch {}
  }

  if (kind === 30023) return renderArticleMeta(event, profile, canonicalUrl)
  if (kind === 1)     return renderNoteMeta(event, profile, canonicalUrl)
  if (kind === 31922 || kind === 31923) return renderEventMeta(event, profile, canonicalUrl)
  if (kind === 31924) return renderCalendarMeta(event, profile, canonicalUrl)
  if (kind === 30402) return renderListingMeta(event, profile, canonicalUrl)
  return null
}

// ── HTML transform ─────────────────────────────────────────────────────────

async function transformAndMaterialize(originalResponse, meta) {
  // HTMLRewriter is the canonical CF Pages way to mutate streamed HTML.
  // We materialize the body to text afterwards so the response can be
  // cloned for cache.put — Cache API can't store a single-use stream.
  //
  // Strip the static OG/Twitter/JSON-LD tags that index.html bakes in
  // for the homepage default — otherwise an entity URL would end up
  // with two og:title tags, two og:image tags, etc. Most unfurlers do
  // last-wins, but a few (LinkedIn historically) take the first match;
  // safer to remove and re-emit cleanly.
  const transformed = new HTMLRewriter()
    .on('title', {
      element(el) { el.setInnerContent(meta.title) },
    })
    .on('meta[name="description"]', {
      element(el) { el.setAttribute('content', meta.description) },
    })
    .on('meta[property^="og:"]',      { element(el) { el.remove() } })
    .on('meta[property^="article:"]', { element(el) { el.remove() } })
    .on('meta[property^="profile:"]', { element(el) { el.remove() } })
    .on('meta[name^="twitter:"]',     { element(el) { el.remove() } })
    .on('script[type="application/ld+json"]', { element(el) { el.remove() } })
    // Drop the homepage's <link rel="canonical"> too — the per-entity
    // headTags below emit one pointing at the canonical bech32 URL,
    // and a duplicate canonical splits the ranking signal.
    .on('link[rel="canonical"]',      { element(el) { el.remove() } })
    .on('head', {
      element(el) { el.append('\n    ' + meta.headTags + '\n  ', { html: true }) },
    })
    .transform(originalResponse)

  const html = await transformed.text()
  const headers = new Headers(originalResponse.headers)
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.set('cache-control', `public, max-age=${CACHE_TTL_SECONDS}`)

  return new Response(html, {
    status: 200,
    headers,
  })
}
