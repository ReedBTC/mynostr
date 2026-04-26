import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptySellForm, formToEventTemplate } from '../../../../lib/sellForm.js'
import { decodeProduct } from '../../../../lib/gamma.js'
import ProductDrawer from '../selling/ProductDrawer.jsx'
import ListingTab from './ListingTab.jsx'
import PhotosTab from './PhotosTab.jsx'
import ShippingTab from './ShippingTab.jsx'
import AdvancedSection from './AdvancedSection.jsx'

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

const TABS = [
  { id: 'listing',  label: 'Listing'  },
  { id: 'photos',   label: 'Photos'   },
  { id: 'shipping', label: 'Shipping' },
]

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
  const [activeTab, setActiveTab] = useState('listing')
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
  // replaced wholesale (single import / load-from-naddr). Both should
  // land the user on the Listing tab fresh with no stale errors.
  useEffect(() => {
    setDiscardArmed(false)
    setActiveTab('listing')
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

  const handlePublish = useCallback(async () => {
    if (!draft) return
    if (!form.title?.trim()) {
      setActiveTab('listing')
      setValidationError('Title is required.')
      return
    }
    if (!form.summary?.trim() && !form.content?.trim()) {
      setActiveTab('listing')
      setValidationError('Add a description or summary.')
      return
    }
    setValidationError('')
    await onPublish(draft.id)
  }, [draft, form, onPublish])

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

      {/* Tab strip + action row — content centered + same horizontal
          extent as the form below so the row visually aligns with the
          body and footer. Tabs left, actions right; flex-wrap so a
          narrow viewport drops the actions onto a second line rather
          than truncating either group. Hidden in the published-success
          state — that view is panel-only with no editing affordances. */}
      <div className={`flex-shrink-0 px-4 pt-3 pb-4 ${published ? 'hidden' : ''}`}>
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-2 flex-wrap">

          {/* Tabs */}
          <div className="flex items-center gap-0">
            {TABS.map(({ id, label }, i, arr) => {
              const isActive = activeTab === id
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`text-xs px-3 py-1.5 border transition-colors
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

          {/* Per-current-draft actions: import / naddr load / export */}
          <div className="flex items-center gap-1.5 flex-wrap">

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
              onAck={() => onDeleteDraft(draft.id)}
            />
          ) : (
            <>
              {activeTab === 'listing' && (
                <>
                  <ListingTab key={`${draft.id}-${draft.replaceVersion || 0}`} form={form} updateForm={updateForm} updatePrice={updatePrice} />
                  {/* Advanced lives only on the Listing tab — its fields
                      are listing-adjacent (NSFW, location, specs, etc.)
                      rather than Photo/Shipping concerns. */}
                  <AdvancedSection
                    form={form}
                    updateForm={updateForm}
                    open={advancedOpen}
                    onToggle={() => setAdvancedOpen(o => !o)}
                  />
                </>
              )}
              {activeTab === 'photos' && (
                <PhotosTab key={`${draft.id}-${draft.replaceVersion || 0}`} form={form} updateForm={updateForm} />
              )}
              {activeTab === 'shipping' && (
                <ShippingTab key={`${draft.id}-${draft.replaceVersion || 0}`} form={form} updateForm={updateForm} />
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer — bar matches body's content width. Hidden when the
          draft is in the published-success state because the panel
          above takes over the whole flow with its own "New listing"
          ack button. On mobile, leftmost slot becomes a "Drafts (N)"
          chip that opens the bottom sheet. */}
      {!published && (
        <div className="flex-shrink-0 px-4 py-3">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-3 flex-wrap pt-3 border-t border-neutral-800">
            <div className="flex items-center gap-3 text-xs">
              {onOpenMobileDrafts && (
                <button
                  onClick={onOpenMobileDrafts}
                  className="md:hidden text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
                >
                  Drafts ({draftsCount})
                </button>
              )}
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
    </div>
  )
}

// Success panel rendered in the composer body when draft.status ===
// 'published'. Shows the canonical naddr (with copy button), the raw
// event id (Plebeian's URL fingerprint), shareable view links, and a
// relay count. The "New listing" button calls onAck — wired by the
// parent to deleteDraft, mirroring the Notes composer's pattern.
function PublishedPanel({ result, onAck }) {
  const naddr   = result?.naddr || ''
  const eventId = result?.eventId || ''
  const relays  = result?.relays || []

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

      <button
        onClick={onAck}
        className="mt-4 w-full py-2 bg-purple-600 hover:bg-purple-500 rounded text-sm text-white font-medium transition-colors"
      >
        New listing
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
