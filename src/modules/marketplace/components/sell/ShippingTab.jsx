/**
 * Shipping tab — alpha minimum: a free-text shipping notes field.
 *
 * Structured shipping options (kind 30406 references) arrive in Phase 2
 * along with the Shipping Options sub-tab in My Selling. For now,
 * sellers describe shipping inline; on publish, the composer appends
 * this content to the description under a "## Shipping" heading so
 * readers see it in flow.
 */
export default function ShippingTab({ form, updateForm }) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1.5">
          Shipping notes
        </label>
        <textarea
          value={form.shippingNotes || ''}
          onChange={(e) => updateForm({ shippingNotes: e.target.value })}
          rows={5}
          placeholder={'Free domestic shipping in the US.\n$15 international.\nShips within 3 business days.'}
          className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors resize-y"
        />
        <p className="text-xs text-neutral-600 mt-1.5">
          Whatever you write here is appended to your description under a
          "Shipping" heading when you publish.
        </p>
      </div>

      <div className="text-xs text-neutral-600 border-t border-neutral-800 pt-3 mt-2">
        Reusable shipping options (per-country tiers, weight-based pricing,
        etc.) ship in a future update — they'll live under My Selling →
        Shipping Options.
      </div>
    </div>
  )
}
