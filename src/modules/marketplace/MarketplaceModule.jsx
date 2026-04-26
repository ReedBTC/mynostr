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
 * Sell tab structure (desktop): drafts tray on the left, composer on
 * the right. Mobile: composer fills the panel; a "Drafts (N)" chip in
 * the composer footer opens the tray as a bottom sheet.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { useSellDrafts } from '../../lib/useSellDrafts.js'
import { eventToForm, formToEventTemplate, isFormMeaningful } from '../../lib/sellForm.js'
import { titleToSlug } from '../../lib/utils.js'
import SellComposer from './components/sell/SellComposer.jsx'
import SellDraftsTray, { fetchListingForLoader } from './components/sell/SellDraftsTray.jsx'
import SellingTab from './components/selling/SellingTab.jsx'

export default function MarketplaceModule({ user, sessionUser, subtab }) {
  const { isOwner } = useOwnerContext()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const npub = user?.npub
  const ownerPubkey = isOwner ? sessionUser?.pubkey : null

  // Multi-draft store. Hook is a no-op (returns empty drafts) when
  // ownerPubkey is null, which happens for visitors — they shouldn't
  // see the Sell tab at all but the hook needs to be called
  // unconditionally for hook-rule compliance.
  const drafts = useSellDrafts(ownerPubkey)

  const [draftsMobileOpen, setDraftsMobileOpen] = useState(false)

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

  // ── Drafts → composer wiring ────────────────────────────────────────
  // Most handlers are thin pass-throughs; import / export / load-from-
  // Nostr live here because they touch the file system and NDK.

  const handleImportDrafts = useCallback(async (files) => {
    // Capture whether the first draft was empty before this run so we
    // can drop it after importing — saves users from N + 1 drafts when
    // they import into a fresh tray with the seeded blank.
    const seedDraft = drafts.drafts[0]
    const seedWasEmpty = seedDraft && !isFormMeaningful(seedDraft.snapshot)

    const result = { imported: 0, errors: [] }
    for (const f of files) {
      const name = f.name || 'file'
      // 1 MB cap matches the Notes import path. Listings are mostly
      // text + image URLs so 1 MB is generous; the cap exists to stop
      // an accidental wrong-file pick (or a deeply-nested malicious
      // JSON) from blocking the browser on read/parse.
      if (f.size > 1_000_000) {
        result.errors.push(`${name}: over 1 MB`)
        continue
      }
      try {
        const text = await f.text()
        const ev = JSON.parse(text)
        if (!ev || typeof ev !== 'object') throw new Error('not a JSON object')
        const snapshot = eventToForm(ev)
        if (!snapshot) throw new Error('not a kind 30402 event')
        drafts.createDraft({ snapshot })
        result.imported++
      } catch (e) {
        result.errors.push(`${name}: ${e?.message || 'invalid JSON'}`)
      }
    }

    if (result.imported > 0 && seedWasEmpty) {
      drafts.deleteDraft(seedDraft.id)
    }
    return result
  }, [drafts])

  const handleExportAllDrafts = useCallback(() => {
    const eligible = drafts.drafts.filter(d => d.snapshot?.title?.trim())
    const result = { exported: 0, skipped: drafts.drafts.length - eligible.length }
    eligible.forEach((d, idx) => {
      try {
        const ev = formToEventTemplate(d.snapshot, { pubkey: ownerPubkey || '' })
        const blob = new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' })
        const url  = URL.createObjectURL(blob)
        const slug = titleToSlug(d.snapshot.title) || `listing-${idx + 1}`
        const a = document.createElement('a')
        a.href = url
        a.download = `${slug}.json`
        // Stagger so the browser's "allow multiple downloads" prompt
        // fires once instead of per-file.
        setTimeout(() => { a.click(); URL.revokeObjectURL(url) }, idx * 150)
        result.exported++
      } catch {
        // Skip individual encode failures rather than aborting the whole batch.
      }
    })
    return result
  }, [drafts.drafts, ownerPubkey])

  // ── Per-current-draft actions (composer top row) ───────────────────
  // Single import / naddr load both REPLACE the current draft's snapshot
  // — same semantics Articles' Editor uses. Saves the current slot from
  // a clobber surprise: the draft id is preserved, the snapshot swaps.

  const handleSingleImport = useCallback(async (file) => {
    if (!drafts.currentDraft) return { ok: false, error: 'No draft selected.' }
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      return { ok: false, error: 'Please pick a .json file.' }
    }
    if (file.size > 1_000_000) {
      return { ok: false, error: 'File too large — 1 MB max.' }
    }
    try {
      const text = await file.text()
      const ev = JSON.parse(text)
      const snapshot = eventToForm(ev)
      if (!snapshot) return { ok: false, error: 'Not a kind 30402 listing event.' }
      drafts.replaceSnapshot(drafts.currentDraft.id, snapshot)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${e?.message || 'parse failed'}` }
    }
  }, [drafts])

  const handleSingleExport = useCallback(() => {
    const d = drafts.currentDraft
    if (!d?.snapshot?.title?.trim()) return
    try {
      const ev   = formToEventTemplate(d.snapshot, { pubkey: ownerPubkey || '' })
      const blob = new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const slug = titleToSlug(d.snapshot.title) || 'listing'
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // Encode shouldn't fail with a non-empty title, but swallow rather
      // than blow up the editor on a freak input.
    }
  }, [drafts.currentDraft, ownerPubkey])

  const handleLoadFromNostr = useCallback(async (input) => {
    if (!drafts.currentDraft) return { ok: false, error: 'No draft selected.' }
    const r = await fetchListingForLoader(input)
    if (!r.ok) return r
    drafts.replaceSnapshot(drafts.currentDraft.id, r.snapshot)
    return { ok: true }
  }, [drafts])

  // ── Edit a published listing ──────────────────────────────────────
  // Loads the listing into the composer as a NEW draft (not replacing
  // the current one — preserves any in-progress draft), selects it,
  // and navigates to the Sell tab. eventToForm handles the heuristic
  // restoration of UI-only fields (nsfw t-tag, mainCategory, shipping
  // notes split out of the markdown content) — these aren't part of
  // the gamma decode shape directly.
  const handleEditListing = useCallback((listing) => {
    if (!isOwner || !listing?.event) return
    const snapshot = eventToForm(listing.event)
    if (!snapshot) return
    drafts.createDraft({ snapshot })
    if (npub) navigate(`/${npub}/marketplace/sell`)
  }, [isOwner, drafts, npub, navigate])

  const sellingLabel   = isOwner ? 'My Selling'   : 'Selling'
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
      {/* Sell tab is always mounted (hidden via CSS) so the drafts
          tray's autosaved state survives a detour through other tabs.
          Mirrors the Notes/Articles "Write tab always mounted" pattern. */}
      <div className={`flex-1 overflow-hidden ${moduleTab === 'sell' && isOwner ? 'flex flex-row' : 'hidden'}`}>
        {isOwner && (
          <>
            <SellDraftsTray
              drafts={drafts.drafts}
              currentDraftId={drafts.currentDraftId}
              onSelectDraft={drafts.setCurrentDraftId}
              onCreateDraft={() => drafts.createDraft()}
              onDeleteDraft={drafts.deleteDraft}
              onDeleteAllDrafts={drafts.deleteAllDrafts}
              onImportDrafts={handleImportDrafts}
              onExportAllDrafts={handleExportAllDrafts}
              onPublishAll={drafts.publishAll}
              isMobile={isMobile}
              isMobileOpen={draftsMobileOpen}
              onMobileClose={() => setDraftsMobileOpen(false)}
            />
            <div className="flex-1 flex flex-col overflow-hidden">
              <SellComposer
                sessionUser={sessionUser}
                draft={drafts.currentDraft}
                onUpdateDraft={drafts.updateDraftWith}
                onDeleteDraft={drafts.deleteDraft}
                onPublish={drafts.publishOne}
                onSingleImport={handleSingleImport}
                onSingleExport={handleSingleExport}
                onLoadFromNostr={handleLoadFromNostr}
                onOpenMobileDrafts={isMobile ? () => setDraftsMobileOpen(true) : null}
                draftsCount={drafts.drafts.length}
              />
            </div>
          </>
        )}
      </div>
      <div className={`flex-1 overflow-hidden ${moduleTab !== 'sell' ? 'flex flex-col' : 'hidden'}`}>
        {moduleTab === 'selling' && (
          <SellingTab
            user={user}
            sessionUser={sessionUser}
            isOwner={isOwner}
            onEdit={handleEditListing}
          />
        )}
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
