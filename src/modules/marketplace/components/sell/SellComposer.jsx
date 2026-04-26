import { useCallback, useEffect, useRef, useState } from 'react'
import { titleToSlug } from '../../../../lib/utils.js'
import { useSellDraft } from '../../../../lib/useSellDraft.js'
import { publishProduct } from '../../../../lib/publishProduct.js'
import ListingTab from './ListingTab.jsx'
import PhotosTab from './PhotosTab.jsx'
import ShippingTab from './ShippingTab.jsx'
import AdvancedSection from './AdvancedSection.jsx'

/**
 * SellComposer — kind 30402 listing publisher.
 *
 * Single state object mirrors the gamma.encodeProduct form shape so
 * draft autosave / publish are both one-liners (`saveDraft(form)`,
 * `publishProduct(form)`).
 *
 * Three top tabs (Listing · Photos · Shipping) plus the always-visible
 * Advanced collapsible. The composer's left/right scroll containers
 * stay still as the user switches tabs — only the tab body re-renders.
 *
 * Alpha simplifications:
 *   • Single auto-saving draft (no multi-draft tray yet).
 *   • Shipping is a free-text notes field appended to the description on
 *     publish. Structured 30406 references arrive in Phase 2.
 *   • New listings only — editing an existing listing piggybacks on the
 *     same composer with `initialForm` populated, but the My Selling
 *     wiring lands in Phase 2.
 */

function emptySellForm() {
  return {
    dTag:        '',
    title:       '',
    summary:     '',
    content:     '',
    location:    '',
    geohash:     '',
    price:       { amount: null, currency: 'SATS', frequency: '' },
    status:      'active',
    visibility:  'on-sale',
    type:        { kind: 'simple', form: 'physical' },
    stock:       null,
    weight:      '',
    dim:         '',
    tTags:       [],
    mainCategory: '',
    images:      [],
    specs:       [],
    collectionRefs: [],
    productRefs:    [],
    shippingOptionRefs: [],
    nsfw:        false,
    shippingNotes: '',
    _extraTags:  [],
  }
}

// Build the form that gets handed to publishProduct. The composer's
// state holds a few view-only fields (mainCategory as a separate slot,
// nsfw as a boolean, shippingNotes as free text) that need lowering
// onto the gamma encode shape at publish time.
function toGammaForm(form) {
  // Merge mainCategory into tTags as the first entry (search relays
  // index `t` tags; putting the primary category first is conventional
  // even if not spec-mandated).
  const tTags = []
  const seen = new Set()
  const pushTag = (t) => {
    const v = String(t || '').trim().toLowerCase()
    if (!v || seen.has(v)) return
    seen.add(v)
    tTags.push(v)
  }
  if (form.mainCategory) pushTag(form.mainCategory)
  for (const t of (form.tTags || [])) pushTag(t)
  if (form.nsfw) pushTag('nsfw')

  // Shipping notes append onto the description with a heading so readers
  // see them in-flow. Skipped if the user didn't fill them in.
  let content = form.content || ''
  if (form.shippingNotes && form.shippingNotes.trim()) {
    const sep = content.endsWith('\n') || !content ? '' : '\n\n'
    content = `${content}${sep}\n## Shipping\n\n${form.shippingNotes.trim()}\n`
  }

  // Generate a dTag if we don't have one. titleToSlug + a short random
  // suffix prevents two listings with the same title from accidentally
  // overwriting each other on the same author's relay set.
  let dTag = form.dTag
  if (!dTag) {
    const slug = titleToSlug(form.title) || 'listing'
    const suffix = Math.random().toString(36).slice(2, 7)
    dTag = `${slug}-${suffix}`
  }

  return {
    ...form,
    dTag,
    tTags,
    content,
  }
}

const TABS = [
  { id: 'listing',  label: 'Listing'  },
  { id: 'photos',   label: 'Photos'   },
  { id: 'shipping', label: 'Shipping' },
]

export default function SellComposer({ sessionUser, initialForm = null }) {
  const pubkey = sessionUser?.pubkey || null
  const { saveDraft, loadDraft, clearDraft } = useSellDraft(pubkey)

  const [form, setForm] = useState(() => initialForm || emptySellForm())
  const [activeTab, setActiveTab] = useState('listing')
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [publishedNaddr, setPublishedNaddr] = useState('')

  // Discard button is two-click: first click arms it (button turns red),
  // second click confirms. Auto-resets after 4s of inactivity so it
  // doesn't sit armed forever waiting to nuke the draft on a stray
  // click. Same UX shape as the Notes DraftsTray delete-row.
  const [discardArmed, setDiscardArmed] = useState(false)
  useEffect(() => {
    if (!discardArmed) return
    const id = setTimeout(() => setDiscardArmed(false), 4000)
    return () => clearTimeout(id)
  }, [discardArmed])

  // Bumped when the form is replaced wholesale (draft load, post-publish
  // reset). Used as a remount key for child components like PriceField
  // that derive internal state from props on mount only — without the
  // remount their state stays stuck on the pre-load values.
  const [formToken, setFormToken] = useState(0)

  // ── Draft autoload (only for fresh composer state, not when caller
  //    passed an explicit initialForm to seed an edit) ─────────────────
  const draftLoadedRef = useRef(false)
  useEffect(() => {
    if (initialForm) return
    if (draftLoadedRef.current) return
    if (!pubkey) return
    const saved = loadDraft()
    if (saved?.form) {
      setForm(saved.form)
      setFormToken(t => t + 1)
    }
    draftLoadedRef.current = true
  }, [pubkey, initialForm, loadDraft])

  // ── Autosave on form changes ────────────────────────────────────────
  useEffect(() => {
    saveDraft(form)
  }, [form, saveDraft])

  // ── Field setters ───────────────────────────────────────────────────
  const updateForm = useCallback((patch) => {
    setForm(prev => ({ ...prev, ...patch }))
  }, [])

  const updatePrice = useCallback((price) => {
    setForm(prev => ({ ...prev, price: { ...prev.price, ...price } }))
  }, [])

  const handlePublish = useCallback(async () => {
    setPublishError('')
    setPublishedNaddr('')
    if (!form.title?.trim()) {
      setPublishError('Title is required.')
      setActiveTab('listing')
      return
    }
    if (!form.summary?.trim() && !form.content?.trim()) {
      setPublishError('Add a description or summary before publishing.')
      setActiveTab('listing')
      return
    }
    setPublishing(true)
    try {
      const gammaForm = toGammaForm(form)
      const { naddr } = await publishProduct(gammaForm)
      setPublishedNaddr(naddr)
      // Reset the form to a fresh empty state so the composer is
      // ready for the next listing rather than displaying the
      // just-published one. The dTag is intentionally NOT preserved —
      // future edits go through My Selling (Phase 2), which will
      // load the existing event into the composer with its own dTag.
      // formToken bumps remount children (PriceField etc.) so their
      // internal state re-derives from the fresh empty form.
      setForm(emptySellForm())
      setFormToken(t => t + 1)
      setActiveTab('listing')
      clearDraft()
    } catch (e) {
      setPublishError(e?.message || 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }, [form, clearDraft])

  const handleDiscardDraft = useCallback(() => {
    if (!pubkey) return
    if (!discardArmed) {
      setDiscardArmed(true)
      return
    }
    setDiscardArmed(false)
    clearDraft()
    setForm(emptySellForm())
    setFormToken(t => t + 1)
    setPublishedNaddr('')
    setPublishError('')
  }, [pubkey, clearDraft, discardArmed])

  if (!pubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        Sign in to create a listing.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Tab strip — content centered + same horizontal extent as the
          form below so tabs visually align with the body and footer. */}
      <div className="flex-shrink-0 px-4 pt-3 pb-4">
        <div className="max-w-2xl mx-auto flex items-center gap-0">
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
      </div>

      {/* Body — scrollable. Content wrapped in a centered max-w-2xl
          column so the form sits in the middle of the panel rather
          than hugging the left edge. The formToken key on the active
          tab forces a remount when the underlying form is replaced
          (draft load, discard) so children like PriceField re-init
          their internal state from the new props. */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-4 pb-6 space-y-6">
          {activeTab === 'listing' && (
            <>
              <ListingTab key={formToken} form={form} updateForm={updateForm} updatePrice={updatePrice} />
              {/* Advanced lives only on the Listing tab — it carries
                  Listing-adjacent fields (NSFW, location, specs, etc.)
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
            <PhotosTab key={formToken} form={form} updateForm={updateForm} />
          )}
          {activeTab === 'shipping' && (
            <ShippingTab key={formToken} form={form} updateForm={updateForm} />
          )}
        </div>
      </div>

      {/* Footer — bar matches the body's content width so the publish
          button sits under the form rather than at the edge of the
          panel. Border-top is inside the centered wrapper so the rule
          ends with the bar. */}
      <div className="flex-shrink-0 px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-3 flex-wrap pt-3 border-t border-neutral-800">
          <div className="flex items-center gap-3 text-xs">
            {publishedNaddr && (
              <span className="text-green-500">✓ Published</span>
            )}
            {publishError && (
              <span className="text-red-400">{publishError}</span>
            )}
            {!publishedNaddr && !publishError && (
              <span className="text-neutral-600">Draft saved automatically</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscardDraft}
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
    </div>
  )
}
