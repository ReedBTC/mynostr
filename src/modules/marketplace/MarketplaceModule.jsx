/**
 * MarketplaceModule — Module 5
 *
 * Four submodules, mirroring Notes/Articles:
 *   Sell          — composer for new listings (owner only)
 *   My Selling    — owner's published kind 30402 listings (visible to all)
 *   My Watchlist  — owner's kind 30405 watchlist collection (visible to all)
 *   Search        — discover listings across marketplace relays (owner only)
 *
 * Visitors (non-owners) see just Selling · Watchlist, matching the
 * Notes/Articles visitor view.
 *
 * Phase 0 lays only the shell + foundation libs (gamma.js, currency.js,
 * marketplaceRelays.js). Each submodule's content arrives in its own
 * phase — placeholders below indicate what's coming.
 */
import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import SellComposer from './components/sell/SellComposer.jsx'

export default function MarketplaceModule({ user, sessionUser, subtab }) {
  const { isOwner } = useOwnerContext()
  const navigate = useNavigate()
  const npub = user?.npub

  // ── Module tab derived from URL subtab ──────────────────────────────────
  // Bare `/marketplace` lands on `selling` (the public-visible owner page),
  // mirroring Notes' default of "My Notes". Owner-only URLs visited by a
  // visitor fall through to the default; the bounce effect below corrects
  // the URL so deep-linked /sell on someone else's page doesn't 404.
  const moduleTab = (() => {
    if (subtab === 'sell' && isOwner)   return 'sell'
    if (subtab === 'search' && isOwner) return 'search'
    if (subtab === 'watchlist')         return 'watchlist'
    if (subtab === 'selling')           return 'selling'
    return 'selling'
  })()

  // `selling` is the default — map it to the bare /marketplace URL so
  // tab clicks and shareable links land consistently on the same path.
  const setModuleTab = useCallback((id) => {
    if (!npub) return
    const path = id === 'selling' ? `/${npub}/marketplace` : `/${npub}/marketplace/${id}`
    navigate(path)
  }, [npub, navigate])

  // Visitor bounce: a non-owner landing on /sell or /search via a stale
  // share or browser back. Same pattern as NotesModule.
  useEffect(() => {
    if (!isOwner && (subtab === 'sell' || subtab === 'search') && npub) {
      navigate(`/${npub}/marketplace`, { replace: true })
    }
  }, [isOwner, subtab, npub, navigate])

  const sellingLabel  = isOwner ? 'My Selling'   : 'Selling'
  const watchlistLabel = isOwner ? 'My Watchlist' : 'Watchlist'

  const visibleTabs = isOwner
    ? [
        { id: 'sell',      label: 'Sell' },
        { id: 'selling',   label: sellingLabel },
        { id: 'watchlist', label: watchlistLabel },
        { id: 'search',    label: 'Search' },
      ]
    : [
        { id: 'selling',   label: sellingLabel },
        { id: 'watchlist', label: watchlistLabel },
      ]

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── Tab bar ── */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
        <div className="flex items-center gap-0 flex-shrink-0">
          {visibleTabs.map(({ id, label }, i, arr) => {
            const isActive = moduleTab === id
            return (
              <button
                key={id}
                onClick={() => setModuleTab(id)}
                className={`text-xs px-2.5 py-1 border transition-colors
                  ${i === 0 ? 'rounded-l' : ''} ${i === arr.length - 1 ? 'rounded-r' : ''}
                  ${isActive
                    ? 'bg-purple-600 border-purple-600 text-white'
                    : 'bg-neutral-900 border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500'}
                  ${i > 0 ? '-ml-px' : ''}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Tab content ── */}
      {/* Sell composer is always mounted (hidden via CSS) so the
          autosaved-draft state survives a detour through other tabs.
          Mirrors the Notes/Articles "Write tab always mounted" pattern. */}
      <div className={`flex-1 overflow-hidden ${moduleTab === 'sell' && isOwner ? 'flex flex-col' : 'hidden'}`}>
        {isOwner && <SellComposer sessionUser={sessionUser} />}
      </div>
      <div className={`flex-1 overflow-auto ${moduleTab !== 'sell' ? '' : 'hidden'}`}>
        {moduleTab === 'selling'   && <PhasePlaceholder phase="2" name="My Selling"
          description="Feed of your kind 30402 listings. Edit · delete · toggle visibility · manage collections + shipping options." />}
        {moduleTab === 'watchlist' && <PhasePlaceholder phase="3" name="My Watchlist"
          description="Kind 30405 collection (d:watchlist) of products you're tracking. Add from any product card." />}
        {moduleTab === 'search'    && <PhasePlaceholder phase="4" name="Search"
          description="Discover listings across marketplace relays. Tag · location · price · NSFW filters." />}
      </div>
    </div>
  )
}

function PhasePlaceholder({ phase, name, description }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-8 py-12 text-center">
      <span className="text-4xl">🛒</span>
      <h2 className="text-lg font-semibold text-neutral-200">{name}</h2>
      <p className="text-sm text-neutral-500 max-w-md">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5 mt-1">
        Phase {phase}
      </span>
    </div>
  )
}
