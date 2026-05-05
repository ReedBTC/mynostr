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
import { renderArticleMeta, renderNoteMeta } from './lib/meta.js'

const SITE_ORIGIN = 'https://mynostr.app'
const CACHE_TTL_SECONDS = 3600
// Bump to invalidate every existing cached entry. Use this when meta-tag
// templates change so old previews don't linger for the TTL window after
// a deploy. Keys live under a synthetic origin so the bump is transparent
// to the request URL itself.
const CACHE_VERSION = 'v3'

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
// Phase 1: articles (kind 30023) and notes (kind 1) only. Other entity
// kinds return null and the request passes through to static HTML.
//
// Recognized URL shapes (both bech32-shortform and canonical app URLs):
//   /naddr1...                              — article, IF kind === 30023
//   /nevent1...                             — note
//   /note1...                               — note
//   /<npub>/articles?article=<naddr>        — article (canonical)
//   /<npub>/notes/<nevent|note>             — note (canonical)
//
function detectEntity(url) {
  const path = url.pathname
  const search = url.searchParams

  // Bech32 single-segment routes (BechResolver targets).
  const naddrPath = /^\/(naddr1[a-z0-9]+)\/?$/i.exec(path)
  if (naddrPath) {
    const decoded = safeDecode(naddrPath[1])
    if (decoded?.type === 'naddr' && decoded.data.kind === 30023) {
      return {
        kind: 30023,
        pubkey: decoded.data.pubkey,
        dTag: decoded.data.identifier,
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

  // Canonical article share URL: /<npub>/articles?article=<naddr>.
  // Trailing /<subtab> (mine, collection, search) is allowed.
  const articleRoute = /^\/(npub1[a-z0-9]+)\/articles(?:\/[a-z]+)?\/?$/i.exec(path)
  if (articleRoute) {
    const naddrParam = search.get('article')
    if (!naddrParam) return null
    const decoded = safeDecode(naddrParam)
    if (decoded?.type === 'naddr' && decoded.data.kind === 30023) {
      return {
        kind: 30023,
        pubkey: decoded.data.pubkey,
        dTag: decoded.data.identifier,
      }
    }
    return null
  }

  // Canonical note detail URL: /<npub>/notes/<nevent|note>.
  const noteDetail = /^\/(npub1[a-z0-9]+)\/notes\/(nevent1[a-z0-9]+|note1[a-z0-9]+)\/?$/i.exec(path)
  if (noteDetail) {
    const decoded = safeDecode(noteDetail[2])
    if (decoded?.type === 'nevent') {
      return { kind: 1, eventId: decoded.data.id, pubkey: decoded.data.author || null }
    }
    if (decoded?.type === 'note') {
      return { kind: 1, eventId: decoded.data, pubkey: null }
    }
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

  // Build the event filter. For articles we have (pubkey, d-tag) → exact
  // match. For notes by id we have the event id directly. If the note
  // arrived via `note1...` (no author hint), we still fetch by id and
  // pick up the author from the returned event.
  let filter
  if (kind === 30023) {
    if (!pubkey || !dTag) return null
    filter = { kinds: [30023], authors: [pubkey], '#d': [dTag], limit: 1 }
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

  // Build the canonical share URL we'll use for og:url. For articles the
  // canonical form is the bech32 naddr (stable across npub changes). For
  // notes we mirror whatever the request URL was — that's what the user
  // shared, and unfurlers should see it back.
  let canonicalUrl = requestUrl
  if (kind === 30023) {
    try {
      const naddr = nip19.naddrEncode({ kind: 30023, pubkey, identifier: dTag })
      canonicalUrl = `${SITE_ORIGIN}/${naddr}`
    } catch {}
  }

  if (kind === 30023) return renderArticleMeta(event, profile, canonicalUrl)
  if (kind === 1)     return renderNoteMeta(event, profile, canonicalUrl)
  return null
}

// ── HTML transform ─────────────────────────────────────────────────────────

async function transformAndMaterialize(originalResponse, meta) {
  // HTMLRewriter is the canonical CF Pages way to mutate streamed HTML.
  // We materialize the body to text afterwards so the response can be
  // cloned for cache.put — Cache API can't store a single-use stream.
  const transformed = new HTMLRewriter()
    .on('title', {
      element(el) { el.setInnerContent(meta.title) },
    })
    .on('meta[name="description"]', {
      element(el) { el.setAttribute('content', meta.description) },
    })
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
