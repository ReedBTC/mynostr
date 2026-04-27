import { useState } from 'react'
import RelayOverrideSection from '../../../notes/components/RelayOverrideSection.jsx'
import MarketplaceRelaySuggestions from './MarketplaceRelaySuggestions.jsx'
import { useSessionCollections } from '../../../../lib/sessionCollectionsContext.jsx'
import { WATCHLIST_D_TAG } from '../../../../lib/gamma.js'

/**
 * AdvancedSection — collapsible "extra knobs" for the Sell composer.
 *
 * Lives below the active tab body and is visible regardless of tab so
 * NSFW / location / specs stay reachable from any tab. Closed by
 * default — most listings don't need any of these.
 *
 * Field choices target the alpha use cases:
 *   • NSFW toggle — affects search filtering, simple boolean.
 *   • Weight / dimensions — for shipping math, free-form text.
 *   • Location / geohash — for local-pickup discovery.
 *   • Additional tags — comma-separated, for free-form discovery.
 *   • Specs — repeatable key/value pairs (size, color, material, etc.)
 *
 * Variants (variable products) intentionally deferred — they require
 * a separate UI for managing the parent → variation hierarchy and
 * aren't needed for first listings.
 */
export default function AdvancedSection({ form, updateForm, open, onToggle }) {
  return (
    <div className="border border-neutral-800 rounded max-w-2xl">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-neutral-300 hover:text-white transition-colors"
      >
        <span>Advanced</span>
        <span className="text-neutral-500">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-3 py-3 border-t border-neutral-800 space-y-4">

          {/* Weight + dim */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Weight" hint="e.g. 250 g, 1.5 lb">
              <input
                type="text"
                value={form.weight}
                onChange={(e) => updateForm({ weight: e.target.value })}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
              />
            </Field>
            <Field label="Dimensions" hint="e.g. 30×20×10 cm">
              <input
                type="text"
                value={form.dim}
                onChange={(e) => updateForm({ dim: e.target.value })}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
              />
            </Field>
          </div>

          {/* Location + geohash */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Location" hint="City / region for local pickup.">
              <input
                type="text"
                value={form.location}
                onChange={(e) => updateForm({ location: e.target.value })}
                placeholder="South Bend, IN"
                className="w-full px-2.5 py-1.5 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
              />
            </Field>
            <Field label="Geohash" hint="Optional. Used for proximity search.">
              <input
                type="text"
                value={form.geohash}
                onChange={(e) => updateForm({ geohash: e.target.value })}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
              />
            </Field>
          </div>

          {/* Additional t-tags */}
          <Field label="Additional tags" hint="Comma-separated. Lowercase recommended.">
            <input
              type="text"
              value={(form.tTags || []).join(', ')}
              onChange={(e) => {
                const list = e.target.value
                  .split(',')
                  .map(t => t.trim().toLowerCase())
                  .filter(Boolean)
                updateForm({ tTags: list })
              }}
              placeholder="vintage, handmade, signed"
              className="w-full px-2.5 py-1.5 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
            />
          </Field>

          {/* Specs */}
          <SpecsEditor
            specs={form.specs || []}
            onChange={(specs) => updateForm({ specs })}
          />

          {/* Publish to collections — multi-select against the user's
              own kind 30405 collections. After publish, the composer
              syncs the selected set against the listing's current
              memberships (adds/removes kind-30405 a-tags as needed). */}
          <CollectionsPicker
            selected={form.publishCollections || []}
            onChange={(publishCollections) => updateForm({ publishCollections })}
          />

          {/* Marketplace relay suggestions — popular marketplace relays
              with ✓/+ controls that add the relay to the user's own
              kind 10002 list (vs. supplementing per-publish). This way
              every future publish/edit/delete naturally reaches them,
              and NIP-09 deletions land where the listing actually
              lives. Reuses the profile module's CopyButton. */}
          <MarketplaceRelaySuggestions />

          {/* Relay override — same component Notes uses, identical
              UX. When enabled, the listing is published only to the
              listed wss:// relays (private-group flow). */}
          <RelayOverrideSection
            relayOverride={form.relayOverride || { enabled: false, relays: [] }}
            onChange={(relayOverride) => updateForm({ relayOverride })}
          />

          {/* NSFW — keep last so it's visually separate from the
              everyday fields above. */}
          <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer pt-2 border-t border-neutral-800">
            <input
              type="checkbox"
              checked={!!form.nsfw}
              onChange={(e) => updateForm({ nsfw: e.target.checked })}
              className="accent-purple-600"
            />
            <span>NSFW — hide from default search results</span>
          </label>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-neutral-300 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-neutral-600 mt-1">{hint}</p>}
    </div>
  )
}

function CollectionsPicker({ selected, onChange }) {
  const ctx = useSessionCollections()
  const collections = ctx?.collections || []
  // Pin watchlist first (matches the rest of the collection-picker UI),
  // then user collections by created_at desc — same shape useCollections
  // already returns, so re-sort is a no-op when ctx provides them.
  const ordered = [...collections].sort((a, b) => {
    if (a.decoded.dTag === WATCHLIST_D_TAG) return -1
    if (b.decoded.dTag === WATCHLIST_D_TAG) return 1
    return 0
  })
  const selectedSet = new Set(selected || [])

  function toggle(dTag) {
    const next = new Set(selectedSet)
    if (next.has(dTag)) next.delete(dTag)
    else next.add(dTag)
    onChange([...next])
  }

  return (
    <div>
      <label className="block text-xs font-medium text-neutral-300 mb-1.5">
        Publish to collections
      </label>
      <p className="text-xs text-neutral-600 mb-2">
        After this listing publishes, add it to the selected collections
        (and remove it from any unchecked ones it was previously in).
      </p>

      {ordered.length === 0 ? (
        <p className="text-xs text-neutral-600 px-2 py-1.5 rounded border border-dashed border-neutral-800">
          No collections yet. Create one in the Collections tab.
        </p>
      ) : (
        <ul className="space-y-1 max-h-40 overflow-y-auto pr-1">
          {ordered.map(c => {
            const dTag = c.decoded.dTag
            const isWatchlist = dTag === WATCHLIST_D_TAG
            const checked = selectedSet.has(dTag)
            return (
              <li key={dTag}>
                <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer hover:text-neutral-100 transition-colors">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(dTag)}
                    className="accent-purple-600"
                  />
                  <span className="truncate">
                    {c.decoded.title || (isWatchlist ? 'Watchlist' : 'Untitled')}
                  </span>
                  {isWatchlist && (
                    <span className="text-[9px] uppercase tracking-wide text-amber-400/70">
                      default
                    </span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// Common spec keys. Free-form keys also work — these are just
// autocomplete suggestions to nudge sellers toward consistent
// vocabulary so search filters can group identical values across
// listings. Anything not here is still accepted.
const COMMON_SPEC_KEYS = [
  'size', 'color', 'material', 'brand', 'model', 'condition',
  'year', 'weight', 'dimensions', 'finish', 'pattern', 'style',
  'gender', 'edition', 'format', 'isbn', 'sku',
]

function SpecsEditor({ specs, onChange }) {
  const [keyDraft, setKeyDraft]     = useState('')
  const [valueDraft, setValueDraft] = useState('')

  function add() {
    const k = keyDraft.trim()
    const v = valueDraft.trim()
    if (!k) return
    onChange([...specs, { key: k, value: v }])
    setKeyDraft('')
    setValueDraft('')
  }

  function removeAt(idx) {
    const next = specs.slice()
    next.splice(idx, 1)
    onChange(next)
  }

  return (
    <div>
      <label className="block text-xs font-medium text-neutral-300 mb-1.5">
        Specs
      </label>
      <p className="text-xs text-neutral-600 mb-2">
        Repeatable key/value pairs. Any key works, but using common ones
        like <span className="text-neutral-500">size</span>, <span className="text-neutral-500">color</span>, or <span className="text-neutral-500">material</span> helps buyers filter
        across listings — start typing in the key field for suggestions.
      </p>

      {specs.length > 0 && (
        <ul className="space-y-1.5 mb-2">
          {specs.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-neutral-300 px-2 py-1 rounded bg-neutral-900 border border-neutral-800">
                {s.key}
              </span>
              <span className="text-neutral-500">=</span>
              <span className="text-neutral-300 flex-1 truncate">{s.value}</span>
              <button
                onClick={() => removeAt(i)}
                className="text-neutral-600 hover:text-red-400 transition-colors"
                title="Remove"
              >✕</button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-stretch gap-2">
        <input
          type="text"
          list="mynostr-spec-key-suggestions"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="key"
          className="w-32 px-2.5 py-1.5 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
        />
        <datalist id="mynostr-spec-key-suggestions">
          {COMMON_SPEC_KEYS.map(k => <option key={k} value={k} />)}
        </datalist>
        <input
          type="text"
          value={valueDraft}
          onChange={(e) => setValueDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="value"
          className="flex-1 px-2.5 py-1.5 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
        />
        <button
          onClick={add}
          disabled={!keyDraft.trim()}
          className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  )
}
