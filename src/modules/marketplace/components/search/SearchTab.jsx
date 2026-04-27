/**
 * SearchTab — discovery feed across marketplace relays + the user's
 * own read relays. Owner-only (gated in MarketplaceModule), since the
 * discover-mode is a tool the signed-in user uses, not a property of
 * a profile.
 *
 * Layout:
 *   • Top filter bar — search field (auto-detects npub vs keyword),
 *     category dropdown, currency / price range, sort, advanced chip
 *     for NSFW + own-listings (always included for now).
 *   • Body — same ProductCard grid as My Products. Click → existing
 *     ProductDrawer. Infinite scroll loads more pages from relays.
 *
 * Filter strategy is documented in src/lib/useMarketSearch.js: relay-
 * side handles {kinds, authors, #t}, client-side handles the rest.
 * Changes that affect the relay query trigger a fresh fetch; client-
 * only changes just re-derive the displayed list (cheap).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { useMarketSearch } from '../../../../lib/useMarketSearch.js'
import { useListingProfiles } from '../../../../lib/useListingProfiles.js'
import { SUPPORTED_FIATS } from '../../../../lib/currency.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import { fetchProfiles } from '../../../../lib/primal.js'
import UserSearch from '../../../../components/UserSearch.jsx'
import ProductCard from '../selling/ProductCard.jsx'
import ProductDrawer from '../selling/ProductDrawer.jsx'

const SEARCH_DEBOUNCE_MS = 300

const CATEGORIES = [
  '',  // any
  'art',
  'apparel',
  'books',
  'crafts',
  'digital',
  'electronics',
  'food',
  'home',
  'jewelry',
  'music',
  'photography',
  'services',
  'tools',
  'other',
]

const SORT_OPTIONS = [
  { value: 'newest',     label: 'Newest first' },
  { value: 'price-asc',  label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
]

const NSFW_PREF_KEY = 'mynostr_search_nsfw_v1'
// Per-pubkey filter persistence — mirrors Articles' DiscoverView shape.
// Stores the last-applied filter set so navigating back to Search
// restores what the user was looking at. The seller chip is also in
// the URL via ?seller=, so URL takes precedence on mount when present.
function filtersKey(pubkey) {
  return `mynostr_marketplace_search_filters_${pubkey || 'anon'}`
}
function loadSavedFilters(pubkey) {
  try {
    const raw = localStorage.getItem(filtersKey(pubkey))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function saveFilters(pubkey, data) {
  try { localStorage.setItem(filtersKey(pubkey), JSON.stringify(data)) } catch {}
}

export default function SearchTab({ sessionUser }) {
  const sessionPubkey = sessionUser?.pubkey || null

  // Lazy-load saved filters once on mount — same-render init avoids
  // the flash of "default form, then localStorage values pop in"
  // that a useEffect-based restore would cause. The URL effect below
  // overrides selectedAuthor when ?seller= is present (URL wins for
  // sharing/linking; localStorage is the fallback for "what was I
  // last looking at?").
  const saved = useMemo(() => loadSavedFilters(sessionPubkey) || {}, [sessionPubkey])

  // Two independent filters in the search bar:
  //   • selectedAuthor — pubkey + name + picture, set by UserSearch
  //     (npub paste OR name typeahead). Drives the relay-side filter.
  //   • keyword — free text, debounced. Drives client-side text match
  //     across title / summary / content / tTags / mainCategory.
  const [selectedAuthor, setSelectedAuthor] = useState(saved.selectedAuthor || null)
  const [keywordInput, setKeywordInput] = useState(saved.keyword || '')
  const [debouncedKeyword, setDebouncedKeyword] = useState(saved.keyword || '')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKeyword(keywordInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [keywordInput])

  // ?seller=<npub> URL param ↔ selectedAuthor chip, bidirectional.
  // External nav (drawer's "View their listings", a shared/bookmarked
  // URL, browser back/forward) seeds the chip via the URL → state
  // effect below. User-driven chip changes (UserSearch pick, chip
  // clear, card seller-click, Clear filters) write through pickAuthor
  // / clearAuthor helpers that update both the state and the URL.
  // Cycle-safe: URL → state runs setSelectedAuthor with a same-pubkey
  // guard, and state → URL only fires on user actions, never on the
  // useEffect's setSelectedAuthor.
  const [searchParams, setSearchParams] = useSearchParams()
  const sellerParam = searchParams.get('seller')
  useEffect(() => {
    // Empty param: don't override whatever the user / localStorage
    // has already set. The chip stays as-is.
    if (!sellerParam) return
    let pubkey = null
    try {
      const decoded = nip19.decode(sellerParam)
      if (decoded.type === 'npub') pubkey = decoded.data
    } catch {}
    if (!pubkey) {
      // Non-empty but unparseable — clear the chip so URL and UI
      // agree. Edge case (typed garbage into the address bar); the
      // alternative is leaving a stale chip that contradicts the URL.
      setSelectedAuthor(null)
      return
    }
    let cancelled = false
    // Seed the chip immediately so the filter applies on this render
    // (avoids a flash of "no filter" while the profile fetch runs).
    setSelectedAuthor(prev => (
      prev?.pubkey === pubkey ? prev : { pubkey, name: '', picture: '' }
    ))
    fetchProfiles([pubkey]).then(map => {
      if (cancelled) return
      const p = map.get(pubkey)
      setSelectedAuthor({
        pubkey,
        name: p?.display_name || p?.name || '',
        picture: p?.picture || '',
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [sellerParam])

  // User-action helpers — keep state and URL in sync. Replace=true to
  // avoid stuffing the browser history with one entry per chip change
  // (Back-button should leave search, not undo a chip toggle).
  function pickAuthor(author) {
    setSelectedAuthor(author)
    if (!author?.pubkey) return
    try {
      const npub = nip19.npubEncode(author.pubkey)
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('seller', npub)
        return next
      }, { replace: true })
    } catch {}
  }

  function clearAuthor() {
    setSelectedAuthor(null)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('seller')
      return next
    }, { replace: true })
  }

  // Filters — all lazy-init from saved state (per-pubkey blob).
  const [category,      setCategory]      = useState(saved.category || '')
  const [priceCurrency, setPriceCurrency] = useState(saved.priceCurrency || 'ANY')
  const [priceMinStr,   setPriceMinStr]   = useState(saved.priceMinStr || '')
  const [priceMaxStr,   setPriceMaxStr]   = useState(saved.priceMaxStr || '')
  const [sort,          setSort]          = useState(saved.sort || 'newest')
  const [advancedOpen,  setAdvancedOpen]  = useState(false)
  // NSFW preference is global (not per-pubkey) — same key as before.
  const [includeNSFW,   setIncludeNSFW]   = useState(() => {
    try { return localStorage.getItem(NSFW_PREF_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(NSFW_PREF_KEY, includeNSFW ? '1' : '0') } catch {}
  }, [includeNSFW])

  // Persist the filter blob whenever any tracked filter changes.
  // Debounce so rapid keystrokes in the keyword field don't write
  // localStorage on every character.
  useEffect(() => {
    const t = setTimeout(() => {
      saveFilters(sessionPubkey, {
        selectedAuthor,
        keyword: keywordInput,
        category,
        priceCurrency,
        priceMinStr,
        priceMaxStr,
        sort,
      })
    }, 400)
    return () => clearTimeout(t)
  }, [sessionPubkey, selectedAuthor, keywordInput, category, priceCurrency, priceMinStr, priceMaxStr, sort])

  const priceMin = priceMinStr ? Number(priceMinStr) : null
  const priceMax = priceMaxStr ? Number(priceMaxStr) : null

  const { listings, loading, error, hasMore, loadMore, rawCount } = useMarketSearch({
    sessionPubkey,
    authorPubkey: selectedAuthor?.pubkey || null,
    category: category || null,
    keyword: debouncedKeyword,
    priceMin,
    priceMax,
    priceCurrency,
    includeNSFW,
    sort,
  })

  // Profile map for the seller row on each ProductCard. Accumulates
  // across pagination so authors we've already fetched don't re-query.
  const profileMap = useListingProfiles(listings)

  // No onAuthorClick override — the card's default behavior navigates
  // to /{sessionNpub}/marketplace/search?seller=, which when fired
  // from inside Search just updates the ?seller param in place (URL
  // effect picks it up and re-seeds the chip). Single code path,
  // works the same whether the user is in or out of Search.

  // Click handler for product cards — open drawer.
  const [openListing, setOpenListing] = useState(null)
  // Re-resolve the open listing from the live array so an underlying
  // refresh reflects in the drawer without re-clicking.
  const liveOpenListing = useMemo(() => {
    if (!openListing) return null
    return listings.find(l => l.event.id === openListing.event.id) || openListing
  }, [openListing, listings])

  // Infinite scroll via IntersectionObserver on a sentinel below the grid.
  // Triggers loadMore as the user nears the bottom of the visible content.
  const sentinelRef = useRef(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && hasMore && !loading) {
          loadMore()
        }
      }
    }, { rootMargin: '300px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, loadMore])

  function clearFilters() {
    clearAuthor()  // also strips ?seller= from URL
    setKeywordInput('')
    setCategory('')
    setPriceCurrency('ANY')
    setPriceMinStr('')
    setPriceMaxStr('')
    setSort('newest')
  }

  const hasAnyFilter = !!selectedAuthor || !!keywordInput.trim() || !!category ||
    priceCurrency !== 'ANY' || !!priceMinStr || !!priceMaxStr || sort !== 'newest'

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2 border-b border-neutral-800">
        <div className="max-w-5xl mx-auto space-y-2">
          {/* Author lookup — primary discovery affordance. UserSearch
              handles both npub paste AND name typeahead via Primal's
              user_search (ranked by followers). */}
          {selectedAuthor ? (
            <SelectedAuthorChip
              author={selectedAuthor}
              onClear={clearAuthor}
            />
          ) : (
            <UserSearch
              placeholder="Find a seller — type a name or paste an npub…"
              inputClassName="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-purple-600 placeholder-neutral-600"
              onPickAuthor={(author) => pickAuthor(author)}
            />
          )}

          {/* Keyword + category + sort row. flex-wrap so on narrow
              phones the selects drop below the keyword input instead
              of squeezing it down to nothing. */}
          <div className="flex items-stretch gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[140px]">
              <input
                type="text"
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                placeholder="Filter by keyword (title, description, tags)…"
                className="w-full pl-8 pr-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 placeholder-neutral-600"
              />
              <svg
                width="14" height="14" viewBox="0 0 16 16"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
                fill="none" stroke="currentColor" strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3 3" strokeLinecap="round" />
              </svg>
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="px-2.5 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-200 outline-none focus:border-purple-600"
              aria-label="Category"
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c || 'All categories'}</option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="px-2.5 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-200 outline-none focus:border-purple-600"
              aria-label="Sort"
            >
              {SORT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Price + advanced row */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={priceCurrency}
              onChange={(e) => setPriceCurrency(e.target.value)}
              className="px-2 py-1.5 text-xs rounded border border-neutral-800 bg-neutral-900 text-neutral-300 outline-none focus:border-purple-600"
              aria-label="Price currency"
              title="Filter by listings priced in this currency"
            >
              <option value="ANY">Any currency</option>
              <option value="SATS">Sats</option>
              {SUPPORTED_FIATS.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              value={priceMinStr}
              onChange={(e) => setPriceMinStr(e.target.value)}
              disabled={priceCurrency === 'ANY'}
              placeholder="Min"
              className="w-24 px-2 py-1.5 text-xs rounded border border-neutral-800 bg-neutral-900 text-neutral-200 outline-none focus:border-purple-600 disabled:opacity-40"
              aria-label="Minimum price"
            />
            <input
              type="number"
              min="0"
              value={priceMaxStr}
              onChange={(e) => setPriceMaxStr(e.target.value)}
              disabled={priceCurrency === 'ANY'}
              placeholder="Max"
              className="w-24 px-2 py-1.5 text-xs rounded border border-neutral-800 bg-neutral-900 text-neutral-200 outline-none focus:border-purple-600 disabled:opacity-40"
              aria-label="Maximum price"
            />
            <button
              onClick={() => setAdvancedOpen(o => !o)}
              className="text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600 transition-colors"
            >
              {advancedOpen ? '− Advanced' : '+ Advanced'}
            </button>
            {hasAnyFilter && (
              <button
                onClick={clearFilters}
                className="text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:text-red-400 hover:border-red-900 transition-colors ml-auto"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Advanced row */}
          {advancedOpen && (
            <div className="pt-1 border-t border-neutral-800/60 flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-neutral-400 cursor-pointer hover:text-neutral-200 transition-colors">
                <input
                  type="checkbox"
                  checked={includeNSFW}
                  onChange={(e) => setIncludeNSFW(e.target.checked)}
                  className="accent-purple-600"
                />
                <span>Include NSFW</span>
              </label>
              <span className="text-[10px] text-neutral-600 ml-auto">
                Searching {listings.length === rawCount ? `${rawCount}` : `${listings.length} of ${rawCount}`} listings
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-4 pt-3 pb-6">

          {error && (
            <p className="text-xs text-red-400 mb-3">{error}</p>
          )}

          {!loading && listings.length === 0 && !error && (
            <EmptyState hasFilter={hasAnyFilter} onClear={clearFilters} />
          )}

          {listings.length > 0 && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {listings.map(l => (
                  <ProductCard
                    key={l.event.id}
                    listing={l}
                    sessionUser={sessionUser}
                    profile={profileMap.get(l.event.pubkey)}
                    onClick={() => setOpenListing(l)}
                  />
                ))}
              </div>

              {/* Sentinel for infinite scroll. Always rendered (even
                  when !hasMore) so the IntersectionObserver attaches;
                  loadMore() no-ops when there's nothing more. */}
              <div ref={sentinelRef} className="h-1" aria-hidden />

              {loading && (
                <p className="text-xs text-neutral-500 text-center mt-4">Loading more…</p>
              )}
              {!hasMore && (
                <p className="text-xs text-neutral-600 text-center mt-4">End of results.</p>
              )}
            </>
          )}

          {loading && listings.length === 0 && (
            <SkeletonGrid count={10} />
          )}
        </div>
      </div>

      {liveOpenListing && (
        <ProductDrawer
          listing={liveOpenListing}
          isOwner={liveOpenListing.event.pubkey === sessionPubkey}
          sessionUser={sessionUser}
          profile={profileMap.get(liveOpenListing.event.pubkey)}
          onClose={() => setOpenListing(null)}
        />
      )}
    </div>
  )
}

// Loading-state placeholder grid that mirrors ProductCard's shape:
// aspect-square cover area, two text bars in the body, a small seller
// row at the bottom. animate-pulse on the whole card so the structure
// is recognizable while the relay query is in flight. Wrapped in a
// role=status / aria-live region with sr-only text so screen readers
// announce the loading state instead of going silent.
function SkeletonGrid({ count = 10 }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading marketplace listings…</span>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="bg-neutral-900 border border-neutral-800 rounded overflow-hidden animate-pulse"
            aria-hidden="true"
          >
            <div className="aspect-square w-full bg-neutral-800" />
            <div className="p-2.5 space-y-2">
              <div className="h-3.5 bg-neutral-800 rounded w-4/5" />
              <div className="h-3 bg-neutral-800 rounded w-1/2" />
            </div>
            <div className="px-2.5 py-1.5 border-t border-neutral-800/80 flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-full bg-neutral-800 flex-shrink-0" />
              <div className="h-2.5 bg-neutral-800 rounded flex-1 max-w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SelectedAuthorChip({ author, onClear }) {
  const safePic = author.picture && isSafeUrl(author.picture) ? author.picture : null
  const name = author.name?.trim() || `${author.pubkey.slice(0, 8)}…`
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded border border-purple-800/60 bg-purple-950/30">
      <span className="text-[10px] uppercase tracking-wide text-purple-400 flex-shrink-0">
        Filtering by seller
      </span>
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 overflow-hidden flex-shrink-0 flex items-center justify-center text-[10px] text-neutral-600">
          {safePic ? (
            <img
              src={safePic}
              alt=""
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
              onError={e => { e.currentTarget.style.display = 'none' }}
            />
          ) : (
            <span aria-hidden>👤</span>
          )}
        </div>
        <span className="text-xs text-neutral-200 truncate">{name}</span>
      </div>
      <button
        onClick={onClear}
        title="Clear seller filter"
        aria-label="Clear seller filter"
        className="text-[11px] px-2 py-0.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors flex-shrink-0"
      >
        ✕
      </button>
    </div>
  )
}

function EmptyState({ hasFilter, onClear }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <span className="text-4xl mb-3" aria-hidden>🔎</span>
      <p className="text-sm text-neutral-300 mb-1">
        {hasFilter ? 'No listings match your filters' : 'No listings found'}
      </p>
      <p className="text-xs text-neutral-500 max-w-sm">
        {hasFilter
          ? 'Try broadening your search or clearing some filters.'
          : 'The marketplace relays may be slow to respond. Try again in a moment.'}
      </p>
      {hasFilter && (
        <button
          onClick={onClear}
          className="mt-4 text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}
