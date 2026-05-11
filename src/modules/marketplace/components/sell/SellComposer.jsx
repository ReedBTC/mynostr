import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptySellForm, formToEventTemplate } from '../../../../lib/sellForm.js'
import { decodeProduct, buildProductCoord } from '../../../../lib/gamma.js'
import { useSessionCollections } from '../../../../lib/sessionCollectionsContext.jsx'
import { getNDK, getOwnWriteRelays } from '../../../../lib/ndk.js'
import { fetchUserDmRelays } from '../../../../lib/relayInfo.js'
import ProductDrawer from '../selling/ProductDrawer.jsx'
import ListingTab from './ListingTab.jsx'
import PhotosTab from './PhotosTab.jsx'
import ShippingTab from './ShippingTab.jsx'
import AdvancedSection from './AdvancedSection.jsx'
import LinkExistingListingModal from './LinkExistingListingModal.jsx'
import PrePublishRelayCheckModal from './PrePublishRelayCheckModal.jsx'

const PLEBEIAN_RELAY_URL = 'wss://relay.plebeian.market'

/**
 * SellComposer — kind 30402 listing publisher.
 *
 * Owns no draft state itself; the active draft + its mutators come in
 * from the multi-draft hook (`useSellDrafts`) wired in MarketplaceModule.
 * That keeps the tray + composer reading from the same source of
 * truth — selecting a draft in the tray switches the composer to its
 * snapshot, edits in the composer reflect in the tray instantly.
 *
 * Three top tabs (Listing · Photos · Shipping) plus the Advanced
 * collapsible (only on the Listing tab — Photos/Shipping have no
 * advanced fields). The composer's left/right scroll containers stay
 * still as the user switches tabs — only the tab body re-renders.
 */

// Tabs were removed in favor of a single stream — the row of
// Listing / Photos / Shipping pills looked identical to the
// parent module's Sell · My Products · My Collections · Search
// nav, which led to confusion (users tried tapping module nav
// while filling out a form). Inlining means the user just scrolls
// the form top-to-bottom: identity → description → photos →
// price/stock → shipping → advanced.

export default function SellComposer({
  sessionUser,
  draft,                     // current draft from useSellDrafts
  onUpdateDraft,             // (id, fn) — atomic updater that produces next draft
  onDeleteDraft,             // (id)
  onPublish,                 // (id) — kicks publishOne
  onSingleImport,            // (file) — replaces current draft's snapshot. Returns {ok, error}
  onSingleExport,            // () — downloads current draft as JSON
  onLoadFromNostr,           // (input) — replaces current snapshot from naddr/nevent. Returns {ok, error}
  onOpenMobileDrafts,        // optional — mobile chip handler
  draftsCount = 1,           // for the mobile "Drafts (N)" chip
}) {
  const pubkey = sessionUser?.pubkey || null
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // ── Top-row action state ───────────────────────────────────────────
  // Single-file import (replaces current draft), naddr/nevent loader,
  // and single-file export. Mirror the Articles Editor toolbar shape.
  const importInputRef = useRef(null)
  const [importError,    setImportError]    = useState('')
  const [importLoading,  setImportLoading]  = useState(false)
  const [naddrInput,     setNaddrInput]     = useState('')
  const [naddrError,     setNaddrError]     = useState('')
  const [naddrLoading,   setNaddrLoading]   = useState(false)

  // Preview modal state — opens the same ProductDrawer used in My Selling
  // but in previewMode. The synthetic listing is built by running the
  // current draft through formToEventTemplate (the same transform that
  // happens at publish time) so the preview shows exactly what readers
  // will see. Built lazily on open via useMemo so we don't re-encode on
  // every keystroke.
  const [previewOpen, setPreviewOpen] = useState(false)

  // Discard button is two-click: first click arms it (button turns
  // red), second click confirms. Auto-resets after 4s.
  const [discardArmed, setDiscardArmed] = useState(false)
  useEffect(() => {
    if (!discardArmed) return
    const id = setTimeout(() => setDiscardArmed(false), 4000)
    return () => clearTimeout(id)
  }, [discardArmed])

  // Pre-publish client-side validation errors live here rather than on
  // the draft itself so a missing title doesn't paint the tray's
  // status dot red — `publishError` on the draft means an actual
  // publish-attempt failure (sign timeout, relay reject, etc.).
  const [validationError, setValidationError] = useState('')

  // Reset per-draft local state when the draft id changes (selecting
  // a different draft) OR when the current draft's snapshot is
  // replaced wholesale (single import / load-from-naddr).
  useEffect(() => {
    setDiscardArmed(false)
    setAdvancedOpen(false)
    setValidationError('')
    setImportError('')
    setNaddrInput('')
    setNaddrError('')
  }, [draft?.id, draft?.replaceVersion])

  const form = draft?.snapshot || emptySellForm()

  const updateForm = useCallback((patch) => {
    if (!draft) return
    setValidationError('')
    onUpdateDraft(draft.id, (d) => ({ ...d, snapshot: { ...d.snapshot, ...patch } }))
  }, [draft, onUpdateDraft])

  const updatePrice = useCallback((price) => {
    if (!draft) return
    setValidationError('')
    onUpdateDraft(draft.id, (d) => ({
      ...d,
      snapshot: { ...d.snapshot, price: { ...d.snapshot.price, ...price } },
    }))
  }, [draft, onUpdateDraft])

  const sessionCollectionsCtx = useSessionCollections()
  // Collection-sync progress for the success panel. While `active` is
  // true, the panel shows a "Syncing collections (M of N)…" indicator
  // and disables the "New listing" dismiss button — without this, the
  // user could ack the success state and trigger draft cleanup while
  // background kind-30405 republishes are still firing signer prompts
  // from an unmounted code path. NIP-46 bunker users especially want
  // those prompts grouped with the publish flow, not after.
  const [collectionSync, setCollectionSync] = useState({ active: false, completed: 0, total: 0 })

  // Pre-publish relay-check modal state. Holds the failing-check flags
  // so the modal renders only the relevant sections; null = closed.
  const [relayCheck, setRelayCheck] = useState(null)

  // The actual publish path, extracted so the relay-check gate can call
  // it from either branch (checks pass → straight in; user clicks
  // "Publish anyway" → here from the modal).
  const doPublish = useCallback(async () => {
    setValidationError('')
    const result = await onPublish(draft.id)
    // Sync the listing's kind-30405 memberships against the user's
    // selected collections. publishOne returns the resolved dTag (the
    // form's dTag isn't visible in this closure since it was generated
    // mid-publish). The success panel listens to `collectionSync` so
    // the user sees a "Syncing collections (M of N)" indicator and
    // can't dismiss until the work is done.
    if (result?.ok && result.dTag && pubkey && sessionCollectionsCtx) {
      const aTag = buildProductCoord(pubkey, result.dTag)
      if (aTag) {
        const desired = new Set(form.publishCollections || [])
        const current = new Set(sessionCollectionsCtx.containingCollections(aTag))
        const toAdd    = [...desired].filter(d => !current.has(d))
        const toRemove = [...current].filter(d => !desired.has(d))
        const total = toAdd.length + toRemove.length
        if (total > 0) {
          setCollectionSync({ active: true, completed: 0, total })
          ;(async () => {
            let done = 0
            for (const dTag of toAdd) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await sessionCollectionsCtx.addToCollection(dTag, aTag)
              } catch {
                // Per-collection failures don't block the rest; the
                // user can fix from the Collections tab if needed.
              }
              done++
              setCollectionSync({ active: true, completed: done, total })
            }
            for (const dTag of toRemove) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await sessionCollectionsCtx.removeFromCollection(dTag, aTag)
              } catch {
                // Same — degraded but not broken.
              }
              done++
              setCollectionSync({ active: true, completed: done, total })
            }
            setCollectionSync({ active: false, completed: total, total })
          })()
        }
      }
    }
  }, [draft, form, onPublish, pubkey, sessionCollectionsCtx])

  // Validate, then run the pre-publish relay checks. If everything's
  // in order we go straight to doPublish; if either Plebeian or DM
  // relays are missing we open the advisory modal and let the user
  // add inline (or "Publish anyway"). Failures inside the check
  // shouldn't block publish — fall through to publish on any error
  // so a flaky relay-info fetch can't soft-brick the listing flow.
  const handlePublish = useCallback(async () => {
    if (!draft) return
    if (!form.title?.trim()) {
      setValidationError('Title is required.')
      return
    }
    if (!form.summary?.trim() && !form.content?.trim()) {
      setValidationError('Add a description or summary.')
      return
    }
    setValidationError('')
    if (!pubkey) { doPublish(); return }
    let missingPlebeian = false
    let missingDmRelay  = false
    try {
      const ndk = getNDK()
      const [writeRelays, dmInfo] = await Promise.all([
        getOwnWriteRelays(ndk).catch(() => null),
        fetchUserDmRelays(pubkey).catch(() => ({ relays: [] })),
      ])
      missingPlebeian = !(writeRelays || []).includes(PLEBEIAN_RELAY_URL)
      missingDmRelay  = !(dmInfo?.relays?.length)
    } catch {
      // Fall through to publish — advisory checks must never block.
    }
    if (missingPlebeian || missingDmRelay) {
      setRelayCheck({ missingPlebeian, missingDmRelay })
      return
    }
    doPublish()
  }, [draft, form, pubkey, doPublish])

  // Build the synthetic { event, decoded } shape that ProductDrawer
  // expects from the current draft. Recomputed when `previewOpen`
  // flips so the preview reflects the latest typed state, but not on
  // every keystroke. Returns null when the form is empty enough that
  // a preview wouldn't be useful.
  const previewListing = useMemo(() => {
    if (!previewOpen) return null
    if (!form.title?.trim() && !form.content?.trim() && (form.images || []).length === 0) {
      return null
    }
    try {
      const event = formToEventTemplate(form, { pubkey: pubkey || '' })
      const decoded = decodeProduct(event)
      if (!decoded) return null
      return { event, decoded }
    } catch {
      // Encode can throw on missing required fields. Show a friendly
      // empty state instead of crashing the preview.
      return null
    }
  }, [previewOpen, form, pubkey])

  const handleImportFile = useCallback(async (file) => {
    if (!file || !onSingleImport) return
    setImportError('')
    setImportLoading(true)
    try {
      const r = await onSingleImport(file)
      if (!r?.ok) setImportError(r?.error || 'Import failed.')
    } finally {
      setImportLoading(false)
    }
  }, [onSingleImport])

  const handleNaddrLoad = useCallback(async () => {
    const trimmed = naddrInput.trim()
    if (!trimmed || !onLoadFromNostr) return
    setNaddrError('')
    setNaddrLoading(true)
    try {
      const r = await onLoadFromNostr(trimmed)
      if (r?.ok) setNaddrInput('')
      else setNaddrError(r?.error || 'Load failed.')
    } finally {
      setNaddrLoading(false)
    }
  }, [naddrInput, onLoadFromNostr])

  const handleDiscard = useCallback(() => {
    if (!draft) return
    if (!discardArmed) {
      setDiscardArmed(true)
      return
    }
    setDiscardArmed(false)
    onDeleteDraft(draft.id)
  }, [draft, discardArmed, onDeleteDraft])

  if (!pubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        Sign in to create a listing.
      </div>
    )
  }
  if (!draft) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        No draft selected.
      </div>
    )
  }

  const publishing = draft.status === 'publishing'
  const published  = draft.status === 'published'
  // Footer status precedence: validation > publish failure > idle.
  // The published-success state gets its own full-width panel rendered
  // in the body, so the footer doesn't double-show "✓ Published".
  const footerError = validationError || (draft.status === 'failed' ? draft.publishError : '')

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Action row — per-current-draft import / naddr load / export.
          Tabs were removed in favor of a single stream below; this row
          retains the Drafts mobile chip + import/export controls. */}
      <div className={`flex-shrink-0 px-4 pt-3 pb-4 ${published ? 'hidden' : ''}`}>
        <div className="max-w-2xl mx-auto flex items-center justify-end gap-2 flex-wrap">

          {/* Per-current-draft actions: import / naddr load / export.
              On mobile, the Drafts chip lives here (top row, always
              visible) instead of the footer — quicker access to the
              tray without scrolling all the way down. Hidden on md+
              since the desktop tray is permanently open on the left. */}
          <div className="flex items-center gap-1.5 flex-wrap">

            {onOpenMobileDrafts && (
              <button
                onClick={onOpenMobileDrafts}
                className="md:hidden text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
              >
                Drafts ({draftsCount})
              </button>
            )}

            {/* Single JSON import — replaces current draft's snapshot.
                Multi-file batch import lives in the drafts tray. */}
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) handleImportFile(f)
              }}
            />
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importLoading}
              title="Import a kind 30402 JSON file into the current draft"
              className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
            >
              {importLoading ? '…' : 'Import'}
            </button>

            {/* Load from Nostr — naddr / nevent into current draft */}
            <form
              onSubmit={(e) => { e.preventDefault(); handleNaddrLoad() }}
              className="flex items-center gap-1"
            >
              <input
                type="text"
                value={naddrInput}
                onChange={(e) => { setNaddrInput(e.target.value); if (naddrError) setNaddrError('') }}
                placeholder="naddr1… / nevent1…"
                disabled={naddrLoading}
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 w-36 disabled:opacity-40"
              />
              <button
                type="submit"
                disabled={naddrLoading || !naddrInput.trim()}
                className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
              >
                {naddrLoading ? '…' : 'Load'}
              </button>
            </form>

            {/* Single JSON export — current draft only. Bulk export lives in the tray. */}
            <button
              onClick={onSingleExport}
              disabled={!form.title?.trim()}
              title="Export current draft as JSON"
              className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
            >
              Export
            </button>
          </div>
        </div>

        {/* Inline error row — lives under the actions so the row above
            stays clean when there's nothing to report. */}
        {(importError || naddrError) && (
          <div className="max-w-2xl mx-auto mt-1.5 text-xs text-red-400">
            {importError || naddrError}
          </div>
        )}
      </div>

      {/* Body — scrollable. When the draft is published, the body
          flips to a success panel (mirrors the Notes composer) — the
          tab content stays unmounted while the panel is up so the
          user can't accidentally edit a "published" listing in
          place. Click "New listing" in the panel to delete the
          published-state draft and start fresh.
          The draft.id+replaceVersion key on each tab forces a remount
          when the active draft changes (or its snapshot is replaced
          wholesale via load-from-naddr), so children like PriceField
          re-init their internal state from the new props. */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-4 pb-6 space-y-6">
          {published ? (
            <PublishedPanel
              result={draft.publishResult}
              collectionSync={collectionSync}
              onAck={() => onDeleteDraft(draft.id)}
            />
          ) : (
            <>
              {/* Publish-identity banner — makes the dTag state visible
                  so users know whether this draft will create a new
                  listing or replace an existing one on Nostr. The two
                  states map directly to form.dTag: empty → new, set →
                  replace. Unlink/Link actions flip between them. */}
              <PublishIdentityBanner
                form={form}
                updateForm={updateForm}
                sessionUser={sessionUser}
              />
              {/* Single stream: listing identity + photos + price/etc.
                  → shipping → advanced. ListingTab takes a mediaSlot
                  for PhotosTab so images render between description
                  and price (per Reed's UX feedback — images belong
                  inline with what-is-this, not on a separate tab). */}
              <ListingTab
                key={`${draft.id}-${draft.replaceVersion || 0}-listing`}
                form={form}
                updateForm={updateForm}
                updatePrice={updatePrice}
                mediaSlot={
                  <PhotosTab
                    key={`${draft.id}-${draft.replaceVersion || 0}-photos`}
                    form={form}
                    updateForm={updateForm}
                  />
                }
              />
              <ShippingTab
                key={`${draft.id}-${draft.replaceVersion || 0}-shipping`}
                form={form}
                updateForm={updateForm}
                pubkey={pubkey}
              />
              <AdvancedSection
                form={form}
                updateForm={updateForm}
                open={advancedOpen}
                onToggle={() => setAdvancedOpen(o => !o)}
              />
            </>
          )}
        </div>
      </div>

      {/* Footer — persistent action bar at the bottom of the composer.
          The flex layout above (h-full container, flex-1 overflow-auto
          body, flex-shrink-0 footer) already keeps it pinned to the
          viewport bottom regardless of body scroll. Bg + backdrop-blur
          here just give it the visual character of an app-style action
          bar so users immediately read it as "primary actions live
          here." Hidden in the published-success state. */}
      {!published && (
        <div className="flex-shrink-0 px-4 py-3 bg-neutral-950/90 backdrop-blur-sm border-t border-neutral-800">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 text-xs">
              {/* "Drafts (N)" chip moved to the top action row on
                  mobile (P1) so it's always visible without scrolling
                  to the footer. Footer just shows save status. */}
              {footerError && <span className="text-red-400">{footerError}</span>}
              {!footerError && (
                <span className="text-neutral-600">Draft saved automatically</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPreviewOpen(true)}
                disabled={publishing}
                title="Preview how this listing will appear"
                className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors disabled:opacity-40"
              >
                Preview
              </button>
              <button
                onClick={handleDiscard}
                disabled={publishing}
                className={discardArmed
                  ? 'text-xs px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-40'
                  : 'text-xs px-3 py-1.5 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors disabled:opacity-40'}
              >
                {discardArmed ? 'Click to confirm' : 'Discard'}
              </button>
              <button
                onClick={handlePublish}
                disabled={publishing}
                className="text-sm px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-40 transition-colors"
              >
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview overlay — opens on Preview-button click. Reuses the
          same ProductDrawer component My Selling uses, in previewMode
          so it suppresses the publish-only sections (Edit/Delete,
          external Plebeian/Shopstr links, watchlist + zap stubs). */}
      {previewOpen && (
        previewListing
          ? (
            <ProductDrawer
              listing={previewListing}
              isOwner={false}
              sessionUser={sessionUser}
              previewMode
              onClose={() => setPreviewOpen(false)}
            />
          )
          : (
            <PreviewEmptyState onClose={() => setPreviewOpen(false)} />
          )
      )}

      {/* Pre-publish relay-check modal. Opens only when the user clicks
          Publish AND a check fails — `relayCheck` carries the failing
          flags so the modal renders only the relevant sections. */}
      {relayCheck && (
        <PrePublishRelayCheckModal
          missingPlebeian={relayCheck.missingPlebeian}
          missingDmRelay={relayCheck.missingDmRelay}
          onCancel={() => setRelayCheck(null)}
          onConfirm={() => { setRelayCheck(null); doPublish() }}
        />
      )}
    </div>
  )
}

// Success panel rendered in the composer body when draft.status ===
// 'published'. Shows the canonical naddr (with copy button), the raw
// event id (Plebeian's URL fingerprint), shareable view links, and a
// relay count. The "New listing" button calls onAck — wired by the
// parent to deleteDraft, mirroring the Notes composer's pattern.
function PublishedPanel({ result, collectionSync, onAck }) {
  const naddr   = result?.naddr || ''
  const eventId = result?.eventId || ''
  const relays  = result?.relays || []
  const syncing = collectionSync?.active

  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])

  async function handleCopyNaddr() {
    if (!naddr) return
    try {
      await navigator.clipboard.writeText(naddr)
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard (insecure context, permissions denied) — silent;
      // user can still hand-copy the visible naddr text.
    }
  }

  return (
    <div className="bg-green-900/20 border border-green-800 rounded-lg p-4">
      <p className="text-green-400 font-medium text-sm mb-3">Published!</p>

      {/* naddr — canonical sharable identifier for replaceable kinds */}
      {naddr && (
        <div className="mb-2.5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">naddr</span>
            <button
              onClick={handleCopyNaddr}
              className="text-[10px] text-neutral-400 hover:text-neutral-100 border border-neutral-700 hover:border-neutral-500 rounded px-2 py-0.5 transition-colors"
              aria-label="Copy naddr"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <code className="text-[10px] text-green-300 bg-neutral-900 px-1.5 py-1 rounded break-all block">
            {naddr}
          </code>
        </div>
      )}

      {/* External viewers — Plebeian uses raw event id, Shopstr + njump take naddr. */}
      <div className="flex items-center gap-3 flex-wrap text-[11px] mt-2">
        {naddr && (
          <a
            href={`https://njump.me/${naddr}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 underline"
          >
            View on njump.me
          </a>
        )}
        {eventId && (
          <a
            href={`https://plebeian.market/products/${eventId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 underline"
          >
            View on Plebeian
          </a>
        )}
        {naddr && (
          <a
            href={`https://shopstr.store/listing/${naddr}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 underline"
          >
            View on Shopstr
          </a>
        )}
      </div>

      {relays.length > 0 && (
        <p className="text-[10px] text-neutral-600 mt-2">
          Sent to {relays.length} relay{relays.length === 1 ? '' : 's'}
        </p>
      )}

      {/* Collection-sync indicator. Active while the post-publish
          kind-30405 republishes are in flight (each one needs a
          signer round-trip). Disables the dismiss button so the user
          doesn't ack-and-navigate-away into background signer prompts. */}
      {collectionSync && collectionSync.total > 0 && (
        <div className="mt-3 flex items-center gap-2 text-[11px]">
          {syncing ? (
            <>
              <span
                className="inline-block w-3 h-3 rounded-full border-2 border-neutral-700 border-t-purple-500 animate-spin"
                aria-hidden
              />
              <span className="text-neutral-400">
                Syncing collections ({collectionSync.completed} of {collectionSync.total})…
              </span>
            </>
          ) : (
            <>
              <span className="inline-block w-3 h-3 rounded-full bg-green-500" aria-hidden />
              <span className="text-neutral-400">
                Collections synced ({collectionSync.total} updated).
              </span>
            </>
          )}
        </div>
      )}

      <button
        onClick={onAck}
        disabled={syncing}
        title={syncing ? 'Wait for collection sync to complete' : undefined}
        className="mt-4 w-full py-2 bg-purple-600 hover:bg-purple-500 rounded text-sm text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-purple-600"
      >
        {syncing ? 'Syncing collections…' : 'New listing'}
      </button>
    </div>
  )
}

// Tiny placeholder when the user clicks Preview on a near-empty draft.
// Reusing ProductDrawer's full chrome would render an "Untitled listing"
// page that's just confusing — better to nudge them toward filling out
// the listing first.
function PreviewEmptyState({ onClose }) {
  return (
    <div
      className="fixed inset-0 z-[50] flex items-center justify-center p-4 bg-black/60"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl p-6 max-w-sm text-center"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium text-neutral-100 mb-1.5">Nothing to preview yet</h3>
        <p className="text-xs text-neutral-400 mb-4">
          Add a title, description, or photo to see how your listing will look.
        </p>
        <button
          onClick={onClose}
          className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  )
}

/**
 * Renders the draft's publish-identity state. Two modes:
 *   • dTag empty → "Will publish as new listing" (green dot). Offers
 *     a "Replace Existing" button that opens the picker so the user
 *     can convert this draft into a replace-existing flow.
 *   • dTag set   → "Will replace existing listing" (blue dot). Shows
 *     the dTag truncated and offers an "Unlink" button that strips
 *     the dTag, converting the draft back to a new-listing flow.
 *
 * This is the explicit visibility surface for the dTag concept —
 * before this banner, the dTag was an invisible piece of state that
 * could silently cause publishes to overwrite each other. With it,
 * users always know which mode they're in and can flip intent.
 */
function PublishIdentityBanner({ form, updateForm, sessionUser }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const dTag = form.dTag || ''

  function handleUnlink() {
    updateForm({ dTag: '', linkedListingTitle: '' })
  }

  function handleLink({ dTag: pickedDTag, title: pickedTitle }) {
    if (pickedDTag) {
      updateForm({
        dTag: pickedDTag,
        // Stamp the linked listing's title at link-time. Independent of
        // form.title so editing the draft's title doesn't relabel the
        // banner — the user always sees which existing listing they're
        // about to replace, regardless of what they're renaming it to.
        linkedListingTitle: pickedTitle || '',
      })
    }
    setPickerOpen(false)
  }

  if (dTag) {
    const dTagDisplay = dTag.length > 32 ? dTag.slice(0, 32) + '…' : dTag
    // Prefer the locked linked-listing title (stamped at link-time);
    // fall back to form.title for legacy drafts that predate this
    // field, then to "(untitled)" as a last resort.
    const titleDisplay = form.linkedListingTitle?.trim()
      || form.title?.trim()
      || '(untitled)'
    return (
      <>
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-blue-900/50 bg-blue-950/25">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" aria-hidden />
          <div className="flex-1 min-w-0 text-xs">
            <p className="text-neutral-200 truncate">
              Will Replace Listing: <span className="font-medium">{titleDisplay}</span>
            </p>
            <p className="text-[10px] text-neutral-500 truncate font-mono mt-0.5">
              d:{dTagDisplay}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => setPickerOpen(true)}
              title="Pick a different listing for this draft to replace"
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              Change…
            </button>
            <button
              onClick={handleUnlink}
              title="Strip the dTag so this draft publishes as a new listing instead"
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              Unlink
            </button>
          </div>
        </div>
        {pickerOpen && (
          <LinkExistingListingModal
            sessionUser={sessionUser}
            currentDTag={dTag}
            onSelect={handleLink}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 rounded border border-green-900/40 bg-green-950/15">
        <span className="inline-block w-2 h-2 rounded-full bg-green-400 flex-shrink-0" aria-hidden />
        <div className="flex-1 min-w-0 text-xs">
          <p className="text-neutral-200">Will publish as new listing</p>
          <p className="text-[10px] text-neutral-500 mt-0.5">
            A new item will be generated on publish
          </p>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          title="Link this draft to an existing listing — publishing will replace that listing's content on Nostr"
          className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors flex-shrink-0"
        >
          Replace Existing
        </button>
      </div>
      {pickerOpen && (
        <LinkExistingListingModal
          sessionUser={sessionUser}
          currentDTag={dTag}
          onSelect={handleLink}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
}
