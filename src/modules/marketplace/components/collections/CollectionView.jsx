import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { withTimeout, isSafeUrl } from '../../../../lib/utils.js'
import {
  parseCoord,
  decodeProduct,
  KIND_PRODUCT,
  WATCHLIST_D_TAG,
} from '../../../../lib/gamma.js'
import { useListingProfiles } from '../../../../lib/useListingProfiles.js'
import ProductCard from '../selling/ProductCard.jsx'
import ProductDrawer from '../selling/ProductDrawer.jsx'
import CollectionEditModal from './CollectionEditModal.jsx'

/**
 * CollectionView — renders a single collection's products as a grid,
 * with the collection's metadata (title, summary, cover image) in a
 * bordered header card containing the action buttons (Edit, Delete,
 * Back, Refresh).
 *
 * Generalized from the original WatchlistTab. The watchlist
 * (d:watchlist) renders here too, but with deletion suppressed —
 * it's a system collection that callers can empty but not destroy.
 */
export default function CollectionView({
  collection,                 // { event, decoded } — required
  user,                       // viewed user (for context)
  sessionUser,
  isOwner,
  collectionsHook,            // useCollections instance from parent
  onBack,                     // optional back handler — null hides the button
}) {
  const { decoded } = collection
  const dTag = decoded.dTag

  const [resolved, setResolved] = useState([])
  // Batch-fetch profiles for whoever's items end up in this collection
  // (collections can mix authors — your watchlist of others' listings,
  // a curated set, etc.). Hook accumulates across re-fetches so the
  // map only grows.
  const profileMap = useListingProfiles(resolved)
  const [unavailableCount, setUnavailableCount] = useState(0)
  const [resolving, setResolving] = useState(false)
  const [openListing, setOpenListing] = useState(null)
  const [editOpen, setEditOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // Resolve productRefs to actual 30402 events. Parallel fetch with
  // per-ref timeout so a stuck relay doesn't block the whole grid.
  useEffect(() => {
    const refs = decoded.productRefs || []
    if (refs.length === 0) {
      setResolved([])
      setUnavailableCount(0)
      return
    }
    let cancelled = false
    setResolving(true)
    ;(async () => {
      const ndk = getNDK()
      await connectAndWait(ndk, 3000).catch(() => {})
      const results = await Promise.all(refs.map(async (ref) => {
        const parsed = parseCoord(ref)
        if (!parsed || parsed.kind !== KIND_PRODUCT) return null
        try {
          const events = await withTimeout(
            ndk.fetchEvents({
              kinds:    [KIND_PRODUCT],
              authors:  [parsed.pubkey],
              '#d':     [parsed.dTag],
            }),
            6000,
            'fetch-timeout',
          )
          let latest = null
          for (const ev of events) {
            if (!latest || (ev.created_at || 0) > (latest.created_at || 0)) latest = ev
          }
          if (!latest) return null
          const dec = decodeProduct(latest)
          if (!dec) return null
          return { event: latest, decoded: dec }
        } catch {
          return null
        }
      }))
      if (cancelled) return
      const out = results.filter(Boolean)
      setResolved(out)
      setUnavailableCount(results.length - out.length)
      setResolving(false)
    })()
    return () => { cancelled = true }
  }, [decoded.productRefs])

  const liveOpenListing = useMemo(() => {
    if (!openListing) return null
    return resolved.find(l => l.decoded.dTag === openListing.decoded.dTag) || null
  }, [openListing, resolved])

  // ── URL sync for the drawer (?listing=<naddr>) ──────────────────────
  // Same pattern as SellingTab / SearchTab. URL bar matches the open
  // listing so copy-from-URL-bar yields a useful share link. Cold-mount
  // auto-opens when the URL param matches a resolved listing.
  const [searchParams, setSearchParams] = useSearchParams()
  const listingParam = searchParams.get('listing') || ''
  const [listingMissNotice, setListingMissNotice] = useState(false)
  const triedListingParamRef = useRef('')
  useEffect(() => {
    if (!listingParam) {
      setListingMissNotice(false)
      triedListingParamRef.current = ''
      return
    }
    if (openListing) return
    if (resolved.length === 0) return
    if (triedListingParamRef.current === listingParam) return
    triedListingParamRef.current = listingParam

    let coord = null
    try {
      const decoded = nip19.decode(listingParam)
      if (decoded.type === 'naddr') coord = decoded.data
    } catch {}
    if (!coord) { setListingMissNotice(true); return }
    const match = resolved.find(l =>
      l.event.pubkey === coord.pubkey && l.decoded.dTag === coord.identifier
    )
    if (match) {
      setOpenListing(match)
      setListingMissNotice(false)
    } else {
      setListingMissNotice(true)
    }
  }, [listingParam, resolved, openListing])

  function openDrawer(listing) {
    setOpenListing(listing)
    try {
      const naddr = nip19.naddrEncode({
        kind:       KIND_PRODUCT,
        pubkey:     listing.event.pubkey,
        identifier: listing.decoded.dTag,
      })
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('listing', naddr)
        return next
      }, { replace: true })
    } catch {}
  }
  function closeDrawer() {
    setOpenListing(null)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('listing')
      return next
    }, { replace: true })
  }

  // Clear stale state if the open listing drifts out of the resolved
  // set (collection edit removed it, collection refresh, etc.). See
  // SellingTab for rationale.
  useEffect(() => {
    if (openListing && !liveOpenListing && resolved.length > 0) {
      closeDrawer()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openListing, liveOpenListing, resolved.length])

  // ── Edit ───────────────────────────────────────────────────────────
  async function handleSaveMeta(patch) {
    return collectionsHook.updateMetadata(dTag, patch)
  }

  // ── Delete (refused for d:watchlist) ──────────────────────────────
  const isWatchlist = dTag === WATCHLIST_D_TAG
  async function handleDeleteClick() {
    if (collectionsHook.pending) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      // Auto-reset confirm after 4s — same UX as the discard button
      // pattern elsewhere in the app.
      setTimeout(() => setConfirmingDelete(false), 4000)
      return
    }
    setConfirmingDelete(false)
    setDeleteError('')
    const r = await collectionsHook.deleteCollection(dTag)
    if (!r.ok) {
      setDeleteError(r.error || 'Delete failed.')
    } else {
      onBack?.()
    }
  }

  const totalLoading = resolving
  const displayTitle = decoded.title || (isWatchlist ? 'Watchlist' : 'Collection')
  const safeCover = decoded.image && isSafeUrl(decoded.image) ? decoded.image : null

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-4 pt-3 pb-3">
        <div className="max-w-5xl mx-auto border border-neutral-800 rounded-lg overflow-hidden bg-neutral-900/40">
          {safeCover && (
            <img
              src={safeCover}
              alt=""
              className="w-full max-h-32 object-cover bg-neutral-950 block"
              onError={(e) => { e.currentTarget.style.opacity = '0.2' }}
            />
          )}

          <div className="px-3 py-2.5 flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-neutral-200 truncate">{displayTitle}</h2>
              {decoded.summary && (
                <p className="text-xs text-neutral-500 mt-0.5 truncate">{decoded.summary}</p>
              )}
              <p className="text-xs text-neutral-600 mt-0.5">
                {totalLoading
                  ? 'Loading…'
                  : `${resolved.length} item${resolved.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
              {onBack && (
                <button
                  onClick={onBack}
                  className="text-xs px-2.5 py-1 rounded border border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 transition-colors"
                >
                  ← Back
                </button>
              )}
              {isOwner && (
                <button
                  onClick={() => setEditOpen(true)}
                  className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
                >
                  Edit
                </button>
              )}
              {isOwner && !isWatchlist && (
                <button
                  onClick={handleDeleteClick}
                  disabled={collectionsHook.pending}
                  className={confirmingDelete
                    ? 'text-xs px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-40'
                    : 'text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-700 transition-colors disabled:opacity-40'}
                >
                  {confirmingDelete ? 'Click to confirm' : 'Delete'}
                </button>
              )}
              <button
                onClick={collectionsHook.reload}
                disabled={totalLoading || collectionsHook.pending}
                className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
              >
                Refresh
              </button>
            </div>
          </div>
          {deleteError && (
            <p className="px-3 pb-2 text-xs text-red-400">{deleteError}</p>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-4 pb-6">
          {listingMissNotice && (
            <div className="mb-3 px-3 py-2 rounded border border-amber-900/60 bg-amber-950/25 text-[11px] text-amber-200 flex items-center justify-between gap-2">
              <span>
                That shared listing isn't in this collection — the link may
                point to a listing in a different collection or one that's
                since been removed.
              </span>
              <button
                type="button"
                onClick={() => {
                  setListingMissNotice(false)
                  setSearchParams(prev => {
                    const next = new URLSearchParams(prev)
                    next.delete('listing')
                    return next
                  }, { replace: true })
                }}
                className="flex-shrink-0 text-amber-300 hover:text-amber-100 px-1.5 py-0.5 rounded border border-amber-900/60 hover:border-amber-800 transition-colors"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}
          {!totalLoading && resolved.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <span className="text-4xl mb-3" aria-hidden>{isWatchlist ? '☆' : '📦'}</span>
              <p className="text-sm text-neutral-300 mb-1">No items in this collection</p>
              <p className="text-xs text-neutral-500 max-w-sm">
                {isOwner
                  ? 'Open a listing\'s detail view and add it to this collection.'
                  : 'This collection is empty.'}
              </p>
            </div>
          )}

          {resolved.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {resolved.map(l => (
                <ProductCard
                  key={l.event.id}
                  listing={l}
                  sessionUser={sessionUser}
                  profile={profileMap.get(l.event.pubkey)}
                  onClick={() => openDrawer(l)}
                />
              ))}
            </div>
          )}

          {unavailableCount > 0 && (
            <p className="text-xs text-neutral-600 mt-4">
              {unavailableCount} item{unavailableCount === 1 ? '' : 's'} in
              this collection couldn't be loaded — the listing may have been
              removed by its author or the relay didn't have a copy.
            </p>
          )}
        </div>
      </div>

      {liveOpenListing && (
        <ProductDrawer
          listing={liveOpenListing}
          isOwner={false}
          sessionUser={sessionUser}
          profile={profileMap.get(liveOpenListing.event.pubkey)}
          onClose={closeDrawer}
        />
      )}

      {editOpen && (
        <CollectionEditModal
          mode="edit"
          headerLabel={isWatchlist ? 'Edit watchlist' : 'Edit collection'}
          initialTitle={decoded.title}
          initialSummary={decoded.summary}
          initialImage={decoded.image}
          onClose={() => setEditOpen(false)}
          onSave={handleSaveMeta}
        />
      )}
    </div>
  )
}
