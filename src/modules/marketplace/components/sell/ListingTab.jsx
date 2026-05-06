import PriceField from './PriceField.jsx'

/**
 * Listing tab — the core product fields most listings need.
 * Title, summary, description (markdown), price, main category, status.
 *
 * Description is a plain `<textarea>` for v1; we can swap in a markdown
 * editor later (Articles uses one) without changing the form shape.
 */

// Common starting categories. Sellers can add custom tags via the
// Advanced section's free-form tTags field; this dropdown is just to
// nudge consistency across the marketplace's most-used buckets.
const COMMON_CATEGORIES = [
  '',  // unselected
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

export default function ListingTab({ form, updateForm, updatePrice, mediaSlot = null }) {
  // mediaSlot lets the parent (SellComposer) inject the photos UI
  // immediately after the description and before price/category. The
  // composer used to render Photos as a separate tab; collapsing the
  // tabs into one stream means images naturally belong inline with
  // the rest of the listing, right after "what is this thing".
  return (
    <div className="space-y-5 max-w-2xl">

      {/* Title */}
      <Field label="Title" required>
        <input
          type="text"
          value={form.title}
          onChange={(e) => updateForm({ title: e.target.value })}
          placeholder="What are you selling?"
          maxLength={200}
          className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
        />
      </Field>

      {/* Summary — short tagline shown in feed cards. Optional but
          recommended; if blank, the description's first line ends up
          carrying the same role. */}
      <Field label="Summary" hint="One-line tagline shown on listing cards. Optional.">
        <input
          type="text"
          value={form.summary}
          onChange={(e) => updateForm({ summary: e.target.value })}
          maxLength={280}
          className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
        />
      </Field>

      {/* Description — markdown body */}
      <Field label="Description" hint="Markdown supported.">
        <textarea
          value={form.content}
          onChange={(e) => updateForm({ content: e.target.value })}
          rows={8}
          placeholder="Condition, dimensions, story behind it, what's included…"
          className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors resize-y"
        />
      </Field>

      {/* Photos render here — between description and price — when the
          parent passes a mediaSlot. */}
      {mediaSlot}

      {/* Price */}
      <Field label="Price">
        <PriceField value={form.price} onChange={updatePrice} />
      </Field>

      {/* Main category */}
      <Field label="Main category" hint="Primary tag for discovery.">
        <select
          value={form.mainCategory}
          onChange={(e) => updateForm({ mainCategory: e.target.value })}
          className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
        >
          {COMMON_CATEGORIES.map(c => (
            <option key={c} value={c}>{c || '— pick a category —'}</option>
          ))}
        </select>
      </Field>

      {/* Stock / visibility / status — all availability state */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Field label="Stock" hint="Leave blank for unlimited.">
          <input
            type="number"
            min="0"
            step="1"
            value={form.stock ?? ''}
            onChange={(e) => {
              const v = e.target.value
              updateForm({ stock: v === '' ? null : Math.max(0, Math.floor(Number(v))) })
            }}
            className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
          />
        </Field>
        <Field label="Visibility">
          <select
            value={form.visibility}
            onChange={(e) => updateForm({ visibility: e.target.value })}
            className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
          >
            <option value="on-sale">On sale (visible)</option>
            <option value="pre-order">Pre-order</option>
            <option value="hidden">Hidden (only you can see it)</option>
          </select>
        </Field>
        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) => updateForm({ status: e.target.value })}
            className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
          >
            <option value="active">Active</option>
            <option value="sold">Sold</option>
          </select>
        </Field>
      </div>
    </div>
  )
}

function Field({ label, required = false, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-neutral-300 mb-1.5">
        {label}
        {required && <span className="text-purple-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-neutral-600 mt-1">{hint}</p>}
    </div>
  )
}
