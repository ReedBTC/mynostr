import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { useSelling } from '../../../../lib/useSelling.js'
import { useListingProfiles } from '../../../../lib/useListingProfiles.js'
import { getNDK } from '../../../../lib/ndk.js'
import { gradeMerchant, gradeListing, hasOptedIntoGamma } from '../../../../lib/gammaCompliance.js'
import { readClassifiedSet, onClassifiedChange } from '../../../../lib/gammaClassified.js'
import { useSessionShippingOptions } from '../../../../lib/sessionShippingOptionsContext.jsx'
import { useNip15Scan } from '../../../../lib/useNip15Scan.js'
import ProductCard from './ProductCard.jsx'
import ProductDrawer from './ProductDrawer.jsx'
import ComplianceBanner from '../compliance/ComplianceBanner.jsx'
import CompliancePanel from '../compliance/CompliancePanel.jsx'
import LegacyMigrationBanner from '../compliance/LegacyMigrationBanner.jsx'
import MigrateLegacyListingsModal from '../compliance/MigrateLegacyListingsModal.jsx'

/**
 * SellingTab — feed of the viewed user's kind 30402 listings.
 *
 * Visible to everyone. Owners (viewing their own page) get extra
 * controls inside the ProductDrawer (Edit / Delete); visitors get the
 * external view links + watchlist + zap.
 *
 * Hidden listings are filtered out of the visitor view but visible
 * to owners — same pattern Articles uses for unpublished/hidden
 * states. Sold listings stay visible (with a "Sold" badge); they're
 * part of the seller's history.
 */
export default function SellingTab({
  user,             // viewed user (whose listings we're showing)
  sessionUser,      // signed-in user (or null)
  isOwner,
  onEdit,           // (decoded) — kicks "edit in composer" flow
}) {
  const pubkey = user?.pubkey || null
  const { listings, loading, error, removeLocal, reload } = useSelling(pubkey)

  const visible = useMemo(() => {
    if (isOwner) return listings
    return listings.filter(l => l.decoded.visibility !== 'hidden')
  }, [listings, isOwner])

  // ── Compliance plumbing (owner-only) ────────────────────────────────
  // Single fetch of kind 0 here so the banner, header score chip, and
  // per-card compliance dots all read from the same verdict. The
  // panel-open state is hoisted here too — both the banner and the
  // chip need to open it.
  //
  // Skipped entirely for visitor views — non-owners don't see any of
  // these surfaces anyway. The provider context + this fetch only run
  // when isOwner is true.
  const sessionShipping = useSessionShippingOptions()
  const shippingOptions = sessionShipping?.options || []

  const [profileEvent, setProfileEvent] = useState(null)
  const [profileToken, setProfileToken] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)
  // When the panel opens via a per-card "Needs attention" click, scroll
  // the panel to that listing's row instead of just opening the panel.
  const [panelFocusListingId, setPanelFocusListingId] = useState(null)
  const [legacyModalOpen, setLegacyModalOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)

  // Per-pubkey set of listings the seller has marked classified-only.
  // Re-reads on any toggle anywhere (mark/unmark in panel or drawer)
  // so the cards, banner, and chip stay in sync without a refresh.
  const [classifiedTick, setClassifiedTick] = useState(0)
  useEffect(() => onClassifiedChange(() => setClassifiedTick(t => t + 1)), [])
  const classifiedSet = useMemo(
    () => isOwner && pubkey ? readClassifiedSet(pubkey) : new Set(),
    [isOwner, pubkey, classifiedTick]
  )

  // Listings the compliance layer should consider. A classified-only
  // listing is hidden from the panel/banner counts AND from per-card
  // dots — the grader stays spec-faithful on the underlying listing,
  // we just stop surfacing the gap to the user.
  const complianceListings = useMemo(
    () => isOwner ? listings.filter(l => !classifiedSet.has(l.decoded.dTag)) : listings,
    [isOwner, listings, classifiedSet]
  )

  // Legacy NIP-15 detection (owner-only). The hook gates its own fetch
  // on a per-pubkey scanFlag so this is essentially free for sellers
  // who've already cleaned up. Banner + modal share the same hook
  // instance so a successful migration in the modal is reflected in
  // the banner count without an extra fetch.
  const {
    candidates: legacyCandidates,
    stalls:     legacyStalls,
    rescan:     rescanLegacy,
    markAllHandled: markAllLegacyHandled,
  } = useNip15Scan(isOwner ? pubkey : null)

  useEffect(() => {
    if (!isOwner || !pubkey) { setProfileEvent(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const ev = await getNDK().fetchEvent({ kinds: [0], authors: [pubkey] })
        if (!cancelled) setProfileEvent(ev || null)
      } catch {
        if (!cancelled) setProfileEvent(null)
      }
    })()
    return () => { cancelled = true }
  }, [isOwner, pubkey, profileToken])

  const verdict = useMemo(() => {
    if (!isOwner) return null
    return gradeMerchant({
      profile:         profileEvent,
      listings:        complianceListings.map(l => l.decoded),
      shippingOptions: shippingOptions.map(o => o.decoded),
    })
  }, [isOwner, profileEvent, complianceListings, shippingOptions])

  // Shop intent — has the seller taken any positive Gamma opt-in
  // action (published a 30406 OR set payment_preference)? Computed
  // from already-loaded data; banner/dot/chip all read from this so
  // the UI is consistent about whether to nag or stay quiet.
  const optedIn = useMemo(() => {
    if (!isOwner) return false
    return hasOptedIntoGamma({ profile: profileEvent, shippingOptions })
  }, [isOwner, profileEvent, shippingOptions])

  // Per-listing grades indexed by event id so each ProductCard can
  // render its own compliance dot without re-grading on every render.
  // Only computed for owners; visitor cards get no grade.
  const listingGrades = useMemo(() => {
    if (!isOwner) return new Map()
    const decodedOptions = shippingOptions.map(o => o.decoded)
    const m = new Map()
    for (const l of listings) {
      // Skip grading classified-only listings — the card dot reads
      // from this map, so absence == no pill rendered.
      if (classifiedSet.has(l.decoded.dTag)) continue
      m.set(l.event.id, gradeListing(l.decoded, decodedOptions))
    }
    return m
  }, [isOwner, listings, shippingOptions, classifiedSet])

  // Batch-fetch the seller profile (just one author here, but reusing
  // the shared hook keeps the rendering path identical to the search +
  // collection feeds).
  const profileMap = useListingProfiles(visible)

  const [openListing, setOpenListing] = useState(null)
  // Re-resolve the open listing from the live array so a re-fetch /
  // optimistic update reflects in the drawer without re-clicking.
  const liveOpenListing = useMemo(() => {
    if (!openListing) return null
    return listings.find(l => l.decoded.dTag === openListing.decoded.dTag) || null
  }, [openListing, listings])

  // ── URL sync for the drawer ─────────────────────────────────────────
  // Open → push ?listing=<naddr>; close → strip the param. URL bar
  // matches what the user is viewing, so copy-from-URL-bar produces a
  // shareable link (the bech32 resolver at /<naddr> covers the
  // canonical short-form sharing flow; this just keeps the in-app URL
  // honest). On mount/back-forward, if the param matches a listing in
  // the current feed, auto-open the drawer.
  const [searchParams, setSearchParams] = useSearchParams()
  const listingParam = searchParams.get('listing') || ''

  // Cold mount + back/forward: open the drawer when the URL says we
  // should. Skipped if a listing is already open (avoids reopening on
  // every re-render).
  //
  // listingMissNotice surfaces a small inline message when ?listing
  // points at a listing that isn't in the seller's loaded feed (wrong
  // seller, paginated past it, never made it to the relays we hit).
  // Without the notice the user sees a normal feed and has no signal
  // that a deep link landed them on a "broken" page.
  const [listingMissNotice, setListingMissNotice] = useState(false)
  // Track which paramValue we already tried, so a successful auto-open
  // followed by a close doesn't re-fire the miss notice.
  const triedListingParamRef = useRef('')
  useEffect(() => {
    if (!listingParam) {
      setListingMissNotice(false)
      triedListingParamRef.current = ''
      return
    }
    if (openListing) return
    if (listings.length === 0) return  // still loading
    if (triedListingParamRef.current === listingParam) return
    triedListingParamRef.current = listingParam

    let coord = null
    try {
      const decoded = nip19.decode(listingParam)
      if (decoded.type === 'naddr') coord = decoded.data
    } catch {}
    if (!coord) { setListingMissNotice(true); return }
    const match = listings.find(l =>
      l.event.pubkey === coord.pubkey && l.decoded.dTag === coord.identifier
    )
    if (match) {
      setOpenListing(match)
      setListingMissNotice(false)
    } else {
      setListingMissNotice(true)
    }
  }, [listingParam, listings, openListing])

  // Wrapper that flips drawer state and updates the URL in lockstep.
  // setSearchParams takes a function so we don't clobber other params
  // (none here today, but defensive — and SearchTab uses this same
  // pattern alongside ?seller=).
  function openDrawer(listing) {
    setOpenListing(listing)
    try {
      const naddr = nip19.naddrEncode({
        kind:       30402,
        pubkey:     listing.event.pubkey,
        identifier: listing.decoded.dTag,
      })
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('listing', naddr)
        return next
      }, { replace: true })
    } catch {
      // Encode failure (bad pubkey/dTag) — drawer still opens, URL just
      // doesn't sync. No-op rather than block the click.
    }
  }
  function closeDrawer() {
    setOpenListing(null)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('listing')
      return next
    }, { replace: true })
  }

  // Clear stale state if the open listing drifts out of the loaded
  // feed (refresh, filter change, deletion). Without this, the drawer
  // visibly disappears because liveOpenListing went null but the URL
  // still carries ?listing= and openListing still points at the gone
  // record. Gating on listings.length > 0 keeps initial-load (still
  // fetching) from prematurely clearing.
  useEffect(() => {
    if (openListing && !liveOpenListing && listings.length > 0) {
      closeDrawer()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openListing, liveOpenListing, listings.length])

  function handleDelete(listing) {
    removeLocal(listing.decoded.dTag)
    closeDrawer()
  }

  function handleEdit(listing) {
    onEdit?.(listing)
    closeDrawer()
  }

  if (!pubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        No listings to show.
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — count + compliance score chip + reload button.
          Reload manually verifies relay state after a publish so the
          user doesn't have to tab away and back. */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-xs text-neutral-500 flex-shrink-0">
              {loading ? 'Loading…' : `${visible.length} listing${visible.length === 1 ? '' : 's'}`}
            </div>
            {isOwner && verdict && verdict.listingCount > 0 && (optedIn || verdict.listingReadyCount > 0) && (
              <ComplianceScoreChip
                verdict={verdict}
                optedIn={optedIn}
                onClick={() => setPanelOpen(true)}
              />
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={reload}
              disabled={loading}
              className="text-xs px-2.5 py-1 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors disabled:opacity-40"
            >
              {loading ? '…' : 'Refresh'}
            </button>
            {isOwner && (
              <SellingToolsMenu
                open={toolsOpen}
                onOpen={() => setToolsOpen(true)}
                onClose={() => setToolsOpen(false)}
                onRescanLegacy={() => { setToolsOpen(false); rescanLegacy() }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-4 pb-6">

          {isOwner && legacyCandidates.length > 0 && (
            <LegacyMigrationBanner
              count={legacyCandidates.length}
              onOpen={() => setLegacyModalOpen(true)}
            />
          )}

          {isOwner && verdict && listings.length > 0 && (
            <ComplianceBanner
              verdict={verdict}
              hasOptedIn={optedIn}
              onOpen={() => setPanelOpen(true)}
            />
          )}

          {error && (
            <p className="text-xs text-red-400 mb-3">{error}</p>
          )}

          {listingMissNotice && (
            <div className="mb-3 px-3 py-2 rounded border border-amber-900/60 bg-amber-950/25 text-[11px] text-amber-200 flex items-center justify-between gap-2">
              <span>
                That shared listing isn't in this seller's loaded feed yet —
                the deep link may point to a different seller, or the relays
                we tried haven't returned it.
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

          {!loading && visible.length === 0 && !error && (
            <EmptyState isOwner={isOwner} />
          )}

          {visible.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {visible.map(l => (
                <ProductCard
                  key={l.event.id}
                  listing={l}
                  sessionUser={sessionUser}
                  profile={profileMap.get(l.event.pubkey)}
                  complianceGrade={isOwner ? listingGrades.get(l.event.id) : null}
                  hasOptedIntoGamma={isOwner ? optedIn : false}
                  onClick={() => openDrawer(l)}
                  onEdit={onEdit}
                  onOpenCompliance={isOwner ? () => {
                    setPanelFocusListingId(l.event.id)
                    setPanelOpen(true)
                  } : null}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {liveOpenListing && (
        <ProductDrawer
          listing={liveOpenListing}
          isOwner={isOwner}
          sessionUser={sessionUser}
          profile={profileMap.get(liveOpenListing.event.pubkey)}
          onClose={closeDrawer}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      )}

      {panelOpen && verdict && (
        <CompliancePanel
          profileEvent={profileEvent}
          listings={listings}
          shippingOptions={shippingOptions}
          profileLud16={user?.profile?.lud16 || ''}
          focusListingId={panelFocusListingId}
          onClose={() => { setPanelOpen(false); setPanelFocusListingId(null) }}
          onProfileUpdated={() => setProfileToken(t => t + 1)}
          onListingsUpdated={reload}
        />
      )}

      {legacyModalOpen && (
        <MigrateLegacyListingsModal
          candidates={legacyCandidates}
          stalls={legacyStalls}
          onMarkAllHandled={markAllLegacyHandled}
          onClose={() => setLegacyModalOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * Header chip for Gamma checkout readiness. Tone is intent-aware:
 *   - Fully ready (every listing checkout-ready) → emerald ✓ "All N support checkout"
 *   - Some ready, some not, shop has opted in → amber, "X of Y support checkout"
 *   - Some ready, others bare, shop hasn't opted in elsewhere → neutral sky chrome
 *     ("opt-in is per-listing, not a deficiency")
 *
 * Never red. The chip is a status, not an alarm — alarms live in the
 * banner when there are real hard gaps. SellingTab also hides the chip
 * entirely when there's nothing to score (no ready listings AND no shop
 * opt-in) so a brand-new seller doesn't see a stat tracker for a feature
 * they haven't engaged with.
 *
 * Click opens the CompliancePanel — useful even after the banner is
 * dismissed for the session.
 */
function ComplianceScoreChip({ verdict, optedIn, onClick }) {
  const ready  = verdict.listingReadyCount
  const total  = verdict.listingCount
  const allOk  = ready === total

  // Tones are deliberately quiet: only fully-ready earns a colored chip
  // (positive signal). Partial-progress and not-opted-in both render
  // neutral so the header doesn't scream "your shop is broken" to a
  // seller who hasn't finished (or doesn't want) Gamma checkout.
  const tone = allOk
    ? 'border-emerald-800 text-emerald-300 bg-emerald-950/30 hover:bg-emerald-900/40'
    : 'border-neutral-700 text-neutral-300 bg-neutral-900/40 hover:bg-neutral-800/60'

  return (
    <button
      type="button"
      onClick={onClick}
      title="Open Gamma checkout setup"
      className={`text-[11px] font-medium px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${tone}`}
    >
      <span aria-hidden>✓</span>
      <span>{allOk ? `All ${total} support checkout` : `${ready} of ${total} support checkout`}</span>
    </button>
  )
}

function EmptyState({ isOwner }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <span className="text-4xl mb-3" aria-hidden>🛒</span>
      <p className="text-sm text-neutral-300 mb-1">No listings yet</p>
      <p className="text-xs text-neutral-500 max-w-sm">
        {isOwner
          ? 'Click the Sell tab to publish your first NIP-99 listing. Everything you publish here is fully NIP-99 / Gamma compliant — checkout works in any Nostr marketplace app.'
          : 'Nothing for sale here right now.'}
      </p>
    </div>
  )
}

/**
 * Owner-only overflow next to Refresh. Single item today ("Re-scan for
 * legacy listings"); designed to grow as we add more shop-level tools.
 * Click-outside closes via document listener; Escape also dismisses.
 */
function SellingToolsMenu({ open, onOpen, onClose, onRescanLegacy }) {
  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (e.target.closest && e.target.closest('[data-selling-tools="true"]')) return
      onClose?.()
    }
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return (
    <div className="relative" data-selling-tools="true">
      <button
        type="button"
        onClick={() => (open ? onClose?.() : onOpen?.())}
        title="Selling tools"
        aria-label="Selling tools"
        aria-expanded={open}
        className="text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors leading-none"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 w-[220px]">
          <button
            type="button"
            onClick={onRescanLegacy}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            Re-scan for legacy listings
          </button>
        </div>
      )}
    </div>
  )
}
