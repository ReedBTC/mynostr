// Cloudflare Pages Function — surfaces GitHub issues labeled
// `known-issue` for the in-app "Known Issues" modal.
//
// Why a worker (vs the browser calling api.github.com directly):
//   - One outbound IP from the edge keeps us well under GitHub's 60
//     req/hr unauthenticated quota even at burst traffic, because the
//     response is edge-cached for 10 minutes.
//   - Lets us strip the GitHub payload down to just the fields the
//     modal renders, keeping the response tiny.
//   - Fail-open: any GitHub hiccup returns an empty list with 200, so
//     the modal stays usable instead of showing an error from a CORS
//     preflight or 5xx.
//
// The list is curated: only issues a maintainer has tagged
// `known-issue` show up. The raw bug-reporter relay firehose stays
// private — triage happens in GitHub first.

const REPO = 'ReedBTC/mynostr'
const LABEL = 'known-issue'
const CACHE_TTL_SECONDS = 600
const CACHE_VERSION = 'v1'

export async function onRequest(context) {
  const { request } = context
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Edge cache lookup — same pattern as _middleware.js. Synthetic
  // origin keeps the cache key independent of the request host.
  const cache = caches.default
  const cacheKey = new Request(
    `https://known-issues-cache.mynostr.app/${CACHE_VERSION}/${REPO}/${LABEL}`,
    { method: 'GET' },
  )
  try {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  } catch {}

  let issues = []
  try {
    const upstream = await fetch(
      `https://api.github.com/repos/${REPO}/issues` +
      `?labels=${encodeURIComponent(LABEL)}&state=open&per_page=50&sort=updated&direction=desc`,
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          // GitHub requires a UA on every request. Identify ourselves
          // so they can reach out if we somehow misbehave.
          'User-Agent': 'mynostr-known-issues (+https://mynostr.app)',
        },
        // CF fetch defaults are fine; no cf.cacheTtl needed because
        // we manage the cache layer ourselves above.
      },
    )
    if (upstream.ok) {
      const raw = await upstream.json()
      issues = (Array.isArray(raw) ? raw : [])
        // GitHub returns PRs from this endpoint too — drop them.
        .filter(it => !it.pull_request)
        .map(it => ({
          number: it.number,
          title: it.title,
          html_url: it.html_url,
          created_at: it.created_at,
          updated_at: it.updated_at,
          comments: it.comments,
          labels: (it.labels || [])
            .map(l => ({ name: l.name, color: l.color }))
            // Hide the gating label itself — every row would carry it,
            // so it adds noise without information.
            .filter(l => l.name !== LABEL),
        }))
    }
  } catch {
    // fail-open with [] below
  }

  const body = JSON.stringify({ issues, fetched_at: new Date().toISOString() })
  const response = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 10 min at the edge; browser may revalidate immediately. The
      // edge cache is what actually shields GitHub from our traffic.
      'cache-control': `public, max-age=60, s-maxage=${CACHE_TTL_SECONDS}`,
      'access-control-allow-origin': '*',
    },
  })

  try {
    // waitUntil so the response ships immediately and the cache write
    // doesn't block the request.
    context.waitUntil(cache.put(cacheKey, response.clone()))
  } catch {}

  return response
}
