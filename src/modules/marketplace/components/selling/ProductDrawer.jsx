import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { nip19 } from 'nostr-tools'
import { Z } from '../../../../lib/zIndex.js'
import { isSafeUrl, parseDateString } from '../../../../lib/utils.js'
import {
  getCachedRates,
  prefetchRates,
  satsToFiat,
  fiatToSats,
  formatAmount,
} from '../../../../lib/currency.js'
import { deleteProduct } from '../../../../lib/deleteProduct.js'
import { KIND_PRODUCT, buildProductCoord } from '../../../../lib/gamma.js'
import { useSessionCollections } from '../../../../lib/sessionCollectionsContext.jsx'
import WatchlistButton from '../watchlist/WatchlistButton.jsx'
import AddToCollectionModal from '../collections/AddToCollectionModal.jsx'

/**
 * ProductDrawer — full detail view for one listing, opened from a
 * card click in SellingTab (and reused by Watchlist + Search later).
 *
 * Layout: centered modal with backdrop. Header has close + owner
 * actions (Edit / Delete with two-click confirm). Body shows hero
 * image + thumbnail strip (multi-image), title, byline, price (sats
 * + fiat conversion), markdown description, structured fields
 * (specs, location, tags), and "View on Plebeian / Shopstr" external
 * links plus stub Watchlist + Zap buttons (Phase 3 wiring).
 *
 * Keyboard: Esc closes. Click backdrop closes. Click panel does
 * nothing (stopPropagation).
 */
export default function ProductDrawer({
  listing,
  isOwner,
  sessionUser,
  profile,           // optional kind-0 profile for the listing's author
  onClose,
  onEdit,            // (listing) — kicks "edit in composer" flow
  onDelete,          // (listing) — confirms removal locally after kind-5 publishes
  previewMode = false,  // true = synthetic listing from draft; suppress publish-only UI
}) {
  const { event, decoded } = listing
  const pubkey = event.pubkey
  const dTag   = decoded.dTag

  // Active hero image index — multi-image listings get a thumbnail
  // strip below the hero that swaps which image is shown big.
  const safeImages = useMemo(
    () => (decoded.images || []).filter(i => i?.url && isSafeUrl(i.url)),
    [decoded.images]
  )
  const [heroIdx, setHeroIdx] = useState(0)
  // Reset hero when the listing changes (e.g. user clicks a different
  // card without closing the drawer first — though we don't currently
  // support that flow, defensive in case it changes).
  useEffect(() => { setHeroIdx(0) }, [event.id])

  // Esc to close.
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // ── Render-time helpers ────────────────────────────────────────────
  const cleanHtml = useMemo(() => {
    if (!decoded.content) return ''
    return DOMPurify.sanitize(marked.parse(decoded.content), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button'],
      FORBID_ATTR: ['style'],
    })
  }, [decoded.content])

  const dateStr = decoded.publishedAt
    ? new Date(decoded.publishedAt * 1000).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : event.created_at
      ? new Date(event.created_at * 1000).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : ''

  // External viewers — Plebeian uses raw event id (hex), Shopstr uses naddr.
  const plebeianUrl = `https://plebeian.market/products/${event.id}`
  const naddr = useMemo(() => {
    try {
      return nip19.naddrEncode({
        kind: KIND_PRODUCT,
        pubkey,
        identifier: dTag,
      })
    } catch { return null }
  }, [pubkey, dTag])
  const shopstrUrl = naddr ? `https://shopstr.store/listing/${naddr}` : null

  return (
    <div
      className={`fixed inset-0 ${Z.modal} flex items-center justify-center p-2 sm:p-4`}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-neutral-950 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden ${Z.modalContent}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <Header
          isOwner={isOwner && !previewMode}
          listing={listing}
          sessionUser={sessionUser}
          onClose={onClose}
          onEdit={onEdit}
          onDelete={onDelete}
          previewMode={previewMode}
        />

        {/* Body — scrollable */}
        <div className="flex-1 overflow-auto">
          <div className="p-4 sm:p-6 space-y-5">

            {/* Hero image */}
            {safeImages.length > 0 && (
              <div>
                <div className="bg-neutral-900 border border-neutral-800 rounded overflow-hidden">
                  <img
                    src={safeImages[heroIdx].url}
                    alt=""
                    className="w-full max-h-[60vh] object-contain bg-neutral-900"
                    onError={(e) => { e.currentTarget.style.opacity = '0.3' }}
                  />
                </div>

                {/* Thumbnail strip — only when there's more than one */}
                {safeImages.length > 1 && (
                  <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
                    {safeImages.map((img, i) => (
                      <button
                        key={img.url}
                        onClick={() => setHeroIdx(i)}
                        className={`flex-shrink-0 w-14 h-14 rounded border overflow-hidden transition-colors ${
                          i === heroIdx
                            ? 'border-purple-500'
                            : 'border-neutral-800 hover:border-neutral-600'
                        }`}
                        aria-label={`Show image ${i + 1}`}
                      >
                        <img src={img.url} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Title + price */}
            <div>
              <h1 className="text-xl sm:text-2xl font-semibold text-neutral-100 leading-tight">
                {decoded.title || 'Untitled listing'}
              </h1>
              {decoded.summary && (
                <p className="text-sm text-neutral-400 mt-1.5">{decoded.summary}</p>
              )}
            </div>

            {/* Seller block — pfp + name + "View profile" link.
                Suppressed in preview (the synthetic listing has no
                real author identity yet). */}
            {!previewMode && (
              <SellerBlock
                pubkey={pubkey}
                profile={profile}
                sessionUser={sessionUser}
                onClose={onClose}
              />
            )}

            <PriceBlock price={decoded.price} />

            {/* Status / visibility chips — surfaced in body too so
                viewers don't miss a 'sold' state if they scroll past
                the small badge in the header thumb. */}
            <StatusRow decoded={decoded} />

            {/* Description (markdown) */}
            {cleanHtml && (
              <div
                className="prose prose-invert prose-sm max-w-none text-neutral-200 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: cleanHtml }}
              />
            )}

            {/* Structured fields — only shown when present */}
            <StructuredFields decoded={decoded} dateStr={dateStr} />

            {/* External viewers + watchlist + zap stubs — suppressed in
                preview because the listing isn't published yet (no
                event id for the Plebeian URL, no naddr that resolves). */}
            {!previewMode && (
              <ExternalLinks
                plebeianUrl={plebeianUrl}
                shopstrUrl={shopstrUrl}
                isOwner={isOwner}
                listing={listing}
                sessionUser={sessionUser}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Header (close + owner actions) ────────────────────────────────────────

function Header({ isOwner, listing, sessionUser, onClose, onEdit, onDelete, previewMode = false }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting]                 = useState(false)
  const [deleteError, setDeleteError]           = useState('')
  const confirmTimerRef = useRef(null)

  // Auto-reset the delete-confirm after 4s of inactivity, same UX
  // shape as the Sell composer's discard button.
  useEffect(() => {
    if (!confirmingDelete) return
    confirmTimerRef.current = setTimeout(() => setConfirmingDelete(false), 4000)
    return () => clearTimeout(confirmTimerRef.current)
  }, [confirmingDelete])

  const sessionCollectionsCtx = useSessionCollections()
  // Phase + progress for the multi-step delete (scan → publish kind-5 →
  // background collection cleanup). Drives the overlay below.
  const [deletePhase, setDeletePhase]   = useState('idle') // 'idle' | 'scanning' | 'deleting' | 'done'
  const [deleteStats, setDeleteStats]   = useState({ candidates: 0, targets: 0, foundOn: 0, acked: 0 })

  async function handleDeleteClick() {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    // Belt-and-suspenders — the UI only renders the Delete button when
    // isOwner is true (page-level check), and useSelling filters
    // listings by author, so this should already be guaranteed. But
    // a stale state or future refactor could leak through; fail-fast
    // here saves a wasted signature + rejected publish round-trip
    // (NIP-09 deletions are only honored when kind-5 author matches
    // the deleted-event author).
    if (listing.event.pubkey !== sessionUser?.pubkey) {
      setDeleteError('Only the author can delete this listing.')
      setConfirmingDelete(false)
      return
    }
    setConfirmingDelete(false)
    setDeleting(true)
    setDeleteError('')
    setDeletePhase('scanning')
    // Snapshot the listing's collection memberships BEFORE the kind-5
    // fires — afterward, any of the user's collections that referenced
    // this listing's coord are dangling. We republish each kind-30405
    // with the dead `a` tag stripped so collection views stop trying
    // to resolve a deleted product.
    const aTag = buildProductCoord(listing.event.pubkey, listing.decoded.dTag)
    const containingDTags = aTag && sessionCollectionsCtx
      ? sessionCollectionsCtx.containingCollections(aTag)
      : []
    try {
      await deleteProduct({
        pubkey: listing.event.pubkey,
        dTag:   listing.decoded.dTag,
        onProgress: (p) => {
          if (p.phase === 'scanning') {
            setDeletePhase('scanning')
            setDeleteStats(s => ({ ...s, candidates: p.candidates || 0 }))
          } else if (p.phase === 'deleting') {
            setDeletePhase('deleting')
            setDeleteStats(s => ({ ...s, targets: p.targets || 0, foundOn: p.foundOn || 0 }))
          } else if (p.phase === 'done') {
            setDeletePhase('done')
            setDeleteStats(s => ({
              ...s,
              targeted: p.targeted || 0,
              acked:    p.acked || 0,
              failures: p.failures || [],
              foundOn:  p.foundOn || 0,
              scanned:  p.scanned || 0,
            }))
          }
        },
      })
      // Background collection cleanup — fire-and-forget. The deletion
      // is the user-facing success signal; stripping dangling refs is
      // post-hoc cleanup. Runs while the user reads the done modal and
      // continues even if they dismiss before it finishes.
      if (aTag && sessionCollectionsCtx && containingDTags.length > 0) {
        ;(async () => {
          for (const dTag of containingDTags) {
            try {
              // eslint-disable-next-line no-await-in-loop
              await sessionCollectionsCtx.removeFromCollection(dTag, aTag)
            } catch {
              // One failed cleanup shouldn't stop the rest. The next
              // collection-view fetch will simply still see a stale
              // ref until the user retries — degraded but not broken.
            }
          }
        })()
      }
      // Modal stays in 'done' phase until the user clicks OK
      // (dismissDoneModal). At that point we close the drawer.
    } catch (e) {
      setDeleteError(e?.message || 'Delete failed')
      setDeletePhase('idle')
    } finally {
      setDeleting(false)
    }
  }

  // User-acknowledged dismiss of the done modal. Closes the drawer +
  // removes from local state. Separate from the optimistic close so the
  // user has a chance to read the relay-ack summary first.
  function dismissDoneModal() {
    setDeletePhase('idle')
    onDelete?.(listing)
  }

  return (
    <div className="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
      <span className="text-xs text-neutral-500">{previewMode ? 'Preview' : 'Listing'}</span>
      {previewMode && (
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-800">
          Draft
        </span>
      )}

      {/* Owner actions */}
      {isOwner && (
        <div className="flex items-center gap-1.5 ml-auto mr-2">
          <button
            onClick={() => onEdit?.(listing)}
            disabled={deleting}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            Edit
          </button>
          <button
            onClick={handleDeleteClick}
            disabled={deleting}
            className={confirmingDelete
              ? 'text-xs px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-40'
              : 'text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-700 transition-colors disabled:opacity-40'}
          >
            {deleting ? 'Deleting…' : confirmingDelete ? 'Click to confirm' : 'Delete'}
          </button>
          {deleteError && <span className="text-xs text-red-400 ml-1 truncate max-w-[14ch]">{deleteError}</span>}
        </div>
      )}

      <button
        onClick={onClose}
        className={`${isOwner ? '' : 'ml-auto '}text-neutral-500 hover:text-neutral-200 transition-colors text-xl leading-none flex-shrink-0 p-1.5 -m-1.5`}
        aria-label="Close"
      >
        ✕
      </button>

      {/* Long-running delete overlay — portaled so it sits above the
          drawer (and above the modal layer it lives in) regardless of
          the Header's stacking context. Stays visible from scan start
          through the done state, where the user must click OK to
          dismiss. */}
      {deletePhase !== 'idle' && createPortal(
        <DeleteProgressOverlay
          phase={deletePhase}
          stats={deleteStats}
          onDismiss={dismissDoneModal}
        />,
        document.body,
      )}
    </div>
  )
}

function DeleteProgressOverlay({ phase, stats, onDismiss }) {
  let title = ''
  let detail = null
  if (phase === 'scanning') {
    title  = 'Scanning relays for this listing…'
    detail = (
      <p className="text-xs text-neutral-400">
        Checking {stats.candidates || '…'} relays where the listing may live.
      </p>
    )
  } else if (phase === 'deleting') {
    title  = 'Sending deletion request…'
    detail = (
      <p className="text-xs text-neutral-400">
        {stats.foundOn
          ? `Found on ${stats.foundOn} relay${stats.foundOn === 1 ? '' : 's'}. Publishing kind-5 to ${stats.targets} target${stats.targets === 1 ? '' : 's'}.`
          : `Publishing kind-5 to ${stats.targets} relay${stats.targets === 1 ? '' : 's'}.`}
      </p>
    )
  } else if (phase === 'done') {
    title = 'Deletion request sent.'
    // Two numbers matter for the user: how many relays we *targeted*
    // (which is your write list + curated set + scan positives), and
    // how many *acknowledged* the request before the timeout. Slow
    // relays often accept the event but don't ack within the window —
    // they'll process it eventually but aren't counted in `acked`.
    const failures = stats.failures || []
    const failedFromOutbox = failures.filter(f => f.fromOutbox)
    const failedFromCurated = failures.filter(f => !f.fromOutbox)
    detail = (
      <div className="text-xs text-neutral-400 space-y-2">
        <p>
          Targeted <span className="text-neutral-200">{stats.targeted}</span> relay
          {stats.targeted === 1 ? '' : 's'} — your relay list plus a curated
          marketplace set. <span className="text-neutral-200">{stats.acked}</span> acknowledged
          the request.
        </p>
        {failures.length > 0 && (
          <div className="border border-neutral-800 rounded p-2 space-y-1.5 max-h-44 overflow-y-auto">
            <p className="text-[11px] text-neutral-500 font-medium">
              {failures.length} relay{failures.length === 1 ? '' : 's'} did not acknowledge:
            </p>
            {failedFromOutbox.length > 0 && (
              <FailureGroup
                label="From your relay list"
                items={failedFromOutbox}
                hint="If a relay here consistently fails, consider removing it from your kind-10002 list — every replaceable event you publish (profile, listings, collections, deletes) has to fan out to it."
              />
            )}
            {failedFromCurated.length > 0 && (
              <FailureGroup
                label="Curated marketplace relays"
                items={failedFromCurated}
                hint={null}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`fixed inset-0 ${Z.nestedConfirm} bg-black/70 flex items-center justify-center p-4`}>
      <div className="max-w-md w-full bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl p-5 space-y-3">
        <div className="flex items-center gap-2.5">
          {phase !== 'done' && (
            <span
              className="inline-block w-3.5 h-3.5 rounded-full border-2 border-neutral-700 border-t-purple-500 animate-spin"
              aria-hidden
            />
          )}
          {phase === 'done' && (
            <span className="inline-block w-3.5 h-3.5 rounded-full bg-green-500 flex-shrink-0" aria-hidden />
          )}
          <h3 className="text-sm font-medium text-neutral-100">{title}</h3>
        </div>
        {detail}
        <div className="border-t border-neutral-800 pt-3">
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Mynostr requests deletion from your relay list and a curated
            set of marketplace and general-purpose relays where this
            listing may have been published. <span className="text-neutral-300">Nostr's
            deletion mechanism is advisory</span> — relays may continue
            serving the deleted event, and the listing may still appear
            here on hard-refresh or in other clients for some time. This
            is a current limitation of the protocol, not a bug.
          </p>
        </div>
        {phase === 'done' && (
          <div className="flex justify-end pt-1">
            <button
              onClick={onDismiss}
              className="text-xs px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors"
            >
              OK
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function FailureGroup({ label, items, hint }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</p>
      <ul className="space-y-0.5">
        {items.map((f) => (
          <li key={f.url} className="text-[11px] text-neutral-300 flex items-start gap-2">
            <span className="font-mono truncate flex-1 min-w-0" title={f.url}>{f.url}</span>
            <span className="text-neutral-500 flex-shrink-0">{f.reason}</span>
          </li>
        ))}
      </ul>
      {hint && (
        <p className="text-[10px] text-neutral-500 leading-relaxed pt-1">{hint}</p>
      )}
    </div>
  )
}

// ─── Seller block (pfp + name + view-profile link) ──────────────────────────

function SellerBlock({ pubkey, profile, sessionUser, onClose }) {
  const navigate = useNavigate()
  // Current URL's npub — used as a fallback "context" for not-logged-
  // in viewers. When the user IS logged in, both navigation paths
  // below land on /{sessionNpub}/marketplace/search instead, so the
  // user ends up on their own marketplace page with the seller filter
  // applied (rather than getting dropped into a read-only view of
  // someone else's profile).
  const { npub: currentUrlNpub } = useParams()
  const name    = profile?.display_name?.trim() || profile?.name?.trim() || ''
  const picture = profile?.picture && isSafeUrl(profile.picture) ? profile.picture : null
  const nip05   = profile?.nip05?.trim() || ''
  const npubShort = (() => {
    try { return nip19.npubEncode(pubkey).slice(0, 16) + '…' } catch { return pubkey.slice(0, 8) + '…' }
  })()

  // Both pfp and "View their listings" buttons share one destination:
  // logged-in user's marketplace search with this seller pinned.
  // Closes the drawer first so the user sees the destination feed,
  // not the modal lingering on top of it.
  function goToSellerListings() {
    try {
      const sellerNpub = nip19.npubEncode(pubkey)
      const baseNpub = sessionUser?.pubkey
        ? nip19.npubEncode(sessionUser.pubkey)
        : (currentUrlNpub || sellerNpub)
      onClose?.()
      navigate(`/${baseNpub}/marketplace/search?seller=${sellerNpub}`, { replace: true })
    } catch {
      // Bad pubkey — no-op.
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded border border-neutral-800 bg-neutral-900">
      <button
        type="button"
        onClick={goToSellerListings}
        className="flex items-center gap-3 flex-1 min-w-0 text-left group"
        title="See this seller's other listings"
      >
        <div className="w-10 h-10 rounded-full bg-neutral-800 border border-neutral-700 overflow-hidden flex-shrink-0 flex items-center justify-center text-neutral-600">
          {picture ? (
            <img
              src={picture}
              alt=""
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
              onError={e => { e.currentTarget.style.display = 'none' }}
            />
          ) : (
            <span aria-hidden>👤</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-100 group-hover:text-white truncate">
            {name || npubShort}
          </p>
          {nip05 && (
            <p className="text-[11px] text-neutral-500 truncate">{nip05}</p>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={goToSellerListings}
        title="See this seller's other listings"
        className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors flex-shrink-0"
      >
        View their listings
      </button>
    </div>
  )
}

// ─── Price (sats + fiat conversion, both prominent) ───────────────────────

function PriceBlock({ price }) {
  const [rates, setRates] = useState(() => getCachedRates())
  useEffect(() => {
    let cancelled = false
    prefetchRates().then(() => {
      if (cancelled) return
      const next = getCachedRates()
      if (next) setRates(next)
    })
    return () => { cancelled = true }
  }, [])

  if (!price || !Number.isFinite(price.amount) || price.amount <= 0) {
    return <p className="text-sm text-neutral-500">No price set</p>
  }

  const primaryCurrency = price.currency || 'SATS'
  const primary = formatAmount(price.amount, primaryCurrency)

  let secondary = null
  if (primaryCurrency === 'SATS') {
    const usd = satsToFiat(price.amount, 'USD', rates)
    if (usd !== null) secondary = formatAmount(usd, 'USD')
  } else {
    const sats = fiatToSats(price.amount, primaryCurrency, rates)
    if (sats !== null) secondary = `${formatAmount(sats, 'SATS')} sats`
  }

  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-2xl font-bold text-purple-300">
        {primary}{primaryCurrency === 'SATS' ? ' sats' : ''}
      </span>
      {secondary && (
        <span className="text-sm text-neutral-500">≈ {secondary}</span>
      )}
    </div>
  )
}

// ─── Status / visibility chips ─────────────────────────────────────────────

function StatusRow({ decoded }) {
  const chips = []
  if (decoded.status === 'sold') {
    chips.push({ label: 'Sold', className: 'bg-red-900/60 text-red-100 border-red-700' })
  }
  if (decoded.visibility === 'hidden') {
    chips.push({ label: 'Hidden', className: 'bg-neutral-800 text-neutral-300 border-neutral-600' })
  }
  if (decoded.visibility === 'pre-order') {
    chips.push({ label: 'Pre-order', className: 'bg-amber-900/60 text-amber-100 border-amber-700' })
  }
  if (chips.length === 0) return null
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {chips.map(c => (
        <span key={c.label} className={`text-xs px-2 py-0.5 rounded border ${c.className}`}>
          {c.label}
        </span>
      ))}
    </div>
  )
}

// ─── Structured fields (specs / location / tags / date) ───────────────────

function StructuredFields({ decoded, dateStr }) {
  const hasSpecs    = (decoded.specs || []).length > 0
  const hasTags     = (decoded.tTags || []).length > 0
  const hasLocation = !!decoded.location
  const hasWeight   = !!decoded.weight
  const hasDim      = !!decoded.dim
  const hasStock    = decoded.stock != null

  if (!hasSpecs && !hasTags && !hasLocation && !hasWeight && !hasDim && !hasStock && !dateStr) {
    return null
  }

  return (
    <div className="border-t border-neutral-800 pt-4 space-y-3 text-sm">
      {hasSpecs && (
        <div>
          <h3 className="text-xs uppercase tracking-wider text-neutral-500 mb-1.5">Specs</h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
            {decoded.specs.map((s, i) => (
              <div key={i} className="contents">
                <dt className="text-neutral-500">{s.key}</dt>
                <dd className="text-neutral-200">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {(hasLocation || hasWeight || hasDim || hasStock) && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {hasLocation && <Field label="Location" value={decoded.location} />}
          {hasStock    && <Field label="Stock"    value={String(decoded.stock)} />}
          {hasWeight   && <Field label="Weight"   value={decoded.weight} />}
          {hasDim      && <Field label="Dimensions" value={decoded.dim} />}
        </div>
      )}

      {hasTags && (
        <div className="flex flex-wrap gap-1.5">
          {decoded.tTags.map(t => (
            <span key={t} className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-neutral-700">
              #{t}
            </span>
          ))}
        </div>
      )}

      {dateStr && (
        <div className="text-xs text-neutral-600">Published {dateStr}</div>
      )}
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-sm text-neutral-200">{value}</div>
    </div>
  )
}

// ─── External links + stubbed watchlist + zap ─────────────────────────────

function ExternalLinks({ plebeianUrl, shopstrUrl, isOwner, listing, sessionUser }) {
  return (
    <div className="border-t border-neutral-800 pt-4 space-y-3">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-neutral-500 mb-1.5">View on another marketplace</h3>
        <p className="text-xs text-neutral-500 mb-2">
          MyNostr doesn't include checkout in the alpha. Open this listing
          on a Nostr marketplace client to contact the seller or buy.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={plebeianUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900 transition-colors"
          >
            View on Plebeian Market ↗
          </a>
          {shopstrUrl && (
            <a
              href={shopstrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900 transition-colors"
            >
              View on Shopstr ↗
            </a>
          )}
        </div>
      </div>

      {/* Watchlist quick toggle + Save-to-collection picker + zap.
          Quick toggle is the one-click case (the watchlist is one
          collection among many). The picker lets users add to any
          named collection. Both mutate the SESSION user's
          collections. Zap is Phase-deferred. */}
      {sessionUser?.pubkey && (
        <ProductDrawerActions listing={listing} sessionUser={sessionUser} />
      )}
    </div>
  )
}

function ProductDrawerActions({ listing, sessionUser }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <WatchlistButton listing={listing} sessionUser={sessionUser} />
      <button
        onClick={() => setPickerOpen(true)}
        className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors"
      >
        Save to collection…
      </button>
      <button
        disabled
        title="Coming soon"
        className="text-xs px-3 py-1.5 rounded border border-neutral-800 text-neutral-600 cursor-not-allowed"
      >
        ⚡ Zap author
      </button>
      {pickerOpen && (
        <AddToCollectionModal
          listing={listing}
          sessionUser={sessionUser}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
