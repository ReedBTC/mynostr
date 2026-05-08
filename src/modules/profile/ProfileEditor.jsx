import { useEffect, useRef, useState } from 'react'
import { isSafeUrl } from '../../lib/utils.js'
import { getNDK } from '../../lib/ndk.js'
import { publishProfile, PROFILE_FIELD_CAPS } from '../../lib/publishProfile.js'
import { PAYMENT_PREFERENCE_VALUES } from '../../lib/gammaCompliance.js'
import {
  parseAppHandlerInput,
  publishCheckoutAppRecommendation,
  fetchCheckoutAppRecommendation,
  deleteCheckoutAppRecommendation,
  isValidRelayHint,
} from '../../lib/publishCheckoutAppRecommendation.js'
import { uploadToBlossom } from '../../lib/blossom.js'
import { useImageUploadFlow } from '../../components/ImageUploadConfirm.jsx'

// Upload cap matches what Blossom's free tier accepts comfortably and keeps
// the main thread's SHA-256 hash under ~100ms. Larger banners are rare.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024  // 8 MB

/**
 * ProfileEditor — form for the standard kind 0 profile fields. Form state
 * uses NIP-01 snake_case (display_name, picture, …) so it maps 1:1 to the
 * event content JSON we publish — no conversion layer.
 *
 * Seeds from the currently-rendered profile object (which has already been
 * normalized to camelCase), then publishProfile() fetches the raw kind 0
 * and merges on top, preserving any non-UI fields.
 */
export default function ProfileEditor({ user, onCancel, onSaved }) {
  const pubkey = user?.pubkey
  const p = user?.profile || {}

  const [form, setForm] = useState({
    display_name: p.displayName || '',
    name:         p.name || '',
    about:        p.about || '',
    picture:      p.image || p.picture || '',
    banner:       p.banner || '',
    nip05:        p.nip05 || '',
    website:      p.website || '',
    lud16:        p.lud16 || '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Per-field upload state so uploading a picture doesn't lock the banner
  // row and vice versa. Errors are scoped to the field that produced them.
  const [uploading, setUploading] = useState({ picture: false, banner: false })
  const [uploadError, setUploadError] = useState({ picture: '', banner: '' })
  const pictureInputRef = useRef(null)
  const bannerInputRef  = useRef(null)
  const { requestUpload, element: uploadPicker } = useImageUploadFlow()

  // Payment preference (Gamma; docs/gamma-spec-snapshot.md §1) lives in
  // event.tags on kind 0, not in the JSON content the rest of this form
  // reads from `user.profile`. Fetch the raw kind 0 + the seller's
  // optional kind 10019 (mint-preference) once on mount so we can seed
  // the radios and gate the eCash option on the prerequisite event.
  //   '' = "manual" / not set (spec default)
  //   'lud16' / 'ecash' = explicit opt-in
  const [paymentPreference, setPaymentPreference] = useState('')
  const [hasMintPreference, setHasMintPreference] = useState(false)
  const [paymentPrefLoaded, setPaymentPrefLoaded] = useState(false)

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    ;(async () => {
      try {
        const ndk = getNDK()
        const [kind0, kind10019] = await Promise.all([
          ndk.fetchEvent({ kinds: [0],     authors: [pubkey] }).catch(() => null),
          ndk.fetchEvent({ kinds: [10019], authors: [pubkey] }).catch(() => null),
        ])
        if (cancelled) return
        const tag = (kind0?.tags || []).find(t => Array.isArray(t) && t[0] === 'payment_preference')
        const value = String(tag?.[1] || '').toLowerCase()
        // Treat unrecognised tag values as "manual" for seeding purposes —
        // the user can still pick a real value to overwrite. The compliance
        // grader will surface the bad value separately.
        setPaymentPreference(PAYMENT_PREFERENCE_VALUES.includes(value) && value !== 'manual' ? value : '')
        setHasMintPreference(!!kind10019)
      } catch {
        // Relay-fetch failure leaves the radios at "manual / not loaded"; the
        // user can still pick a value, and publishProfile re-fetches on
        // save so they won't accidentally clobber an existing tag.
      } finally {
        if (!cancelled) setPaymentPrefLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  function set(k, v) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  async function handleFileUpload(field, e) {
    const file = e.target.files?.[0]
    e.target.value = ''    // reset so re-picking the same file re-fires
    if (!file) return
    setUploadError(prev => ({ ...prev, [field]: '' }))

    // `accept="image/*"` is advisory — guard before the hash round-trip so a
    // forced non-image (or corrupt file.type) doesn't waste an upload slot.
    if (!file.type || !file.type.startsWith('image/')) {
      setUploadError(prev => ({ ...prev, [field]: 'Please choose an image file.' }))
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)
      setUploadError(prev => ({ ...prev, [field]: `Image is too large (max ${mb} MB).` }))
      return
    }

    const ready = await requestUpload(file)
    if (!ready) return

    setUploading(prev => ({ ...prev, [field]: true }))
    try {
      const url = await uploadToBlossom(ready)
      set(field, url)
    } catch (err) {
      setUploadError(prev => ({ ...prev, [field]: err?.message || 'Upload failed.' }))
    } finally {
      setUploading(prev => ({ ...prev, [field]: false }))
    }
  }

  // Fields that must parse as http/https URLs when non-empty. nip05 / lud16
  // are intentionally not validated here — they're identifier-style strings,
  // not URLs, and over-strict validation blocks legitimate values.
  function validate() {
    const problems = []
    if (form.picture && !isSafeUrl(form.picture)) problems.push('Picture URL must start with http:// or https://')
    if (form.banner  && !isSafeUrl(form.banner))  problems.push('Banner URL must start with http:// or https://')
    if (form.website && !isSafeUrl(form.website)) problems.push('Website URL must start with http:// or https://')
    return problems
  }

  async function handleSave() {
    setError(null)
    const problems = validate()
    if (problems.length) { setError(problems.join(' · ')); return }
    if (!pubkey)        { setError('Not signed in.'); return }

    setBusy(true)
    try {
      const trimmed = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
      )
      // payment_preference: empty string = "manual" / spec default. We
      // always remove first then re-add when non-default so a switch from
      // ecash → manual cleanly drops the tag, and a switch from manual →
      // lud16 lands with exactly one tag (publishProfile applies removes
      // before upserts).
      const tagsToRemove = ['payment_preference']
      const tagSet = paymentPreference
        ? [['payment_preference', paymentPreference]]
        : []
      const { profileContent, usedFallbackRelays } = await publishProfile({
        pubkey,
        edits: trimmed,
        tagSet,
        tagsToRemove,
      })
      const warn = usedFallbackRelays
        ? 'Saved to default relays — we couldn\u2019t reach your relay list, so followers on your custom relays may not see the update immediately.'
        : null
      onSaved?.(profileContent, { warning: warn })
    } catch (e) {
      setError(e?.message || 'Publish failed.')
    } finally {
      setBusy(false)
    }
  }

  const bannerPreviewOk = form.banner && isSafeUrl(form.banner)
  const picturePreviewOk = form.picture && isSafeUrl(form.picture)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto w-full">

        {/* Live preview — mirrors the read view so edits land visibly */}
        <div className="relative w-full h-40 bg-neutral-900 border-b border-neutral-800">
          {bannerPreviewOk && (
            <img
              src={form.banner}
              alt=""
              className="w-full h-full object-cover"
              onError={e => { e.target.style.display = 'none' }}
            />
          )}
          <div className="absolute -bottom-12 left-4">
            {picturePreviewOk ? (
              <img
                src={form.picture}
                alt=""
                className="w-24 h-24 rounded-full object-cover bg-neutral-800 ring-4 ring-neutral-950"
                onError={e => { e.target.style.display = 'none' }}
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-neutral-800 ring-4 ring-neutral-950 flex items-center justify-center text-neutral-500 text-2xl">
                ?
              </div>
            )}
          </div>
        </div>

        <form
          onSubmit={e => { e.preventDefault(); handleSave() }}
          className="pt-14 px-4 pb-8 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base text-neutral-200 font-semibold">Edit profile</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-700 hover:border-neutral-500 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="text-xs text-purple-200 bg-purple-800 hover:bg-purple-700 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                {busy ? 'Publishing…' : 'Save'}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400 border border-red-900 rounded px-3 py-2">{error}</p>
          )}

          <Field label="Display name" hint="Shown anywhere your profile appears.">
            <input
              type="text"
              value={form.display_name}
              onChange={e => set('display_name', e.target.value)}
              maxLength={PROFILE_FIELD_CAPS.display_name}
              className={inputCls}
            />
          </Field>

          <Field label="Username" hint="Short handle (name). Optional if you set a display name.">
            <input
              type="text"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              maxLength={PROFILE_FIELD_CAPS.name}
              className={inputCls}
            />
          </Field>

          <Field label="About" hint={`${form.about.length} / ${PROFILE_FIELD_CAPS.about} characters.`}>
            <textarea
              value={form.about}
              onChange={e => set('about', e.target.value)}
              maxLength={PROFILE_FIELD_CAPS.about}
              rows={4}
              className={`${inputCls} resize-y min-h-[88px]`}
            />
          </Field>

          <Field label="Picture" hint="Upload an image or paste an https:// URL.">
            <div className="flex gap-1.5">
              <input
                type="url"
                value={form.picture}
                onChange={e => set('picture', e.target.value)}
                maxLength={PROFILE_FIELD_CAPS.picture}
                className={`${inputCls} flex-1 min-w-0 font-mono`}
                placeholder="https://…"
              />
              <button
                type="button"
                onClick={() => pictureInputRef.current?.click()}
                disabled={uploading.picture || busy}
                className="px-3 py-2 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 text-xs transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                {uploading.picture ? 'Uploading…' : 'Upload'}
              </button>
              <input
                ref={pictureInputRef}
                type="file"
                accept="image/*"
                onChange={e => handleFileUpload('picture', e)}
                className="hidden"
                aria-hidden="true"
              />
            </div>
            {uploadError.picture && (
              <span className="text-[11px] text-red-400 block mt-1" role="alert">{uploadError.picture}</span>
            )}
          </Field>

          <Field label="Banner" hint="Upload an image or paste an https:// URL.">
            <div className="flex gap-1.5">
              <input
                type="url"
                value={form.banner}
                onChange={e => set('banner', e.target.value)}
                maxLength={PROFILE_FIELD_CAPS.banner}
                className={`${inputCls} flex-1 min-w-0 font-mono`}
                placeholder="https://…"
              />
              <button
                type="button"
                onClick={() => bannerInputRef.current?.click()}
                disabled={uploading.banner || busy}
                className="px-3 py-2 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 text-xs transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                {uploading.banner ? 'Uploading…' : 'Upload'}
              </button>
              <input
                ref={bannerInputRef}
                type="file"
                accept="image/*"
                onChange={e => handleFileUpload('banner', e)}
                className="hidden"
                aria-hidden="true"
              />
            </div>
            {uploadError.banner && (
              <span className="text-[11px] text-red-400 block mt-1" role="alert">{uploadError.banner}</span>
            )}
          </Field>

          <Field label="NIP-05" hint="Verified handle, e.g. alice@example.com.">
            <input
              type="text"
              value={form.nip05}
              onChange={e => set('nip05', e.target.value)}
              maxLength={PROFILE_FIELD_CAPS.nip05}
              className={inputCls}
              placeholder="name@domain.com"
            />
          </Field>

          <Field label="Website">
            <input
              type="url"
              value={form.website}
              onChange={e => set('website', e.target.value)}
              maxLength={PROFILE_FIELD_CAPS.website}
              className={inputCls}
              placeholder="https://…"
            />
          </Field>

          <Field label="Lightning address" hint="lud16 — payable like an email.">
            <input
              type="text"
              value={form.lud16}
              onChange={e => set('lud16', e.target.value)}
              maxLength={PROFILE_FIELD_CAPS.lud16}
              className={inputCls}
              placeholder="you@walletofsatoshi.com"
            />
          </Field>

          <PaymentPreferenceField
            value={paymentPreference}
            onChange={setPaymentPreference}
            hasLud16={!!form.lud16.trim()}
            hasMintPreference={hasMintPreference}
            loaded={paymentPrefLoaded}
          />

          <CheckoutAppField pubkey={pubkey} />

          <p className="text-[11px] text-neutral-600 pt-2 border-t border-neutral-800">
            Publishing overwrites your existing kind 0 event. Any fields not
            shown here are preserved from your current profile.
          </p>
        </form>
      </div>
      {uploadPicker}
    </div>
  )
}

const inputCls =
  'w-full font-mono bg-neutral-900 border border-neutral-700 focus:border-purple-600 rounded px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none'

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-400 block mb-1">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-neutral-600 block mt-1">{hint}</span>}
    </label>
  )
}

/**
 * Marketplace-side `payment_preference` setting (Gamma spec, see
 * docs/gamma-spec-snapshot.md §1). Controls how third-party marketplace
 * apps (Shopstr, Plebeian, etc.) route payment when buyers check out
 * against this seller's listings.
 *
 * Three options:
 *   - 'manual' (value: '')  — buyers DM the seller, who replies with a
 *     payment request. Spec default; emits no tag.
 *   - 'lud16'               — auto-pay to the seller's Lightning address.
 *     Gated on lud16 being set in the form above.
 *   - 'ecash'               — pay via Cashu mints. Gated on a published
 *     kind 10019; without one, third-party apps can't know which mints
 *     the seller trusts.
 *
 * Disabled options keep the radio visible (so the seller sees the option
 * exists) but make the prerequisite explicit so they know what to fix.
 */
function PaymentPreferenceField({ value, onChange, hasLud16, hasMintPreference, loaded }) {
  const lud16Disabled = !hasLud16
  const ecashDisabled = !hasMintPreference

  // If a previously-saved value becomes invalid (e.g. seller cleared their
  // lud16 in this session), keep the radio visually selected but show a
  // small warning — silently demoting their choice would surprise them
  // on save.
  const lud16Conflict = value === 'lud16' && lud16Disabled
  const ecashConflict = value === 'ecash' && ecashDisabled

  return (
    <div className="space-y-2 pt-2 border-t border-neutral-800">
      <div>
        <span className="text-xs text-neutral-400 block">Payment preference</span>
        <span className="text-[11px] text-neutral-600 block mt-0.5">
          How marketplace apps should route buyer payments for your listings.
          Used by checkout-capable Nostr apps (Shopstr, Plebeian, etc.).
        </span>
      </div>

      <div className="space-y-1.5">
        <PaymentRadio
          name="payment_preference"
          checked={value === ''}
          onChange={() => onChange('')}
          label="Manual"
          hint="Buyers DM you; you send a payment request. Default."
        />
        <PaymentRadio
          name="payment_preference"
          checked={value === 'lud16'}
          onChange={() => onChange('lud16')}
          disabled={lud16Disabled}
          label="Lightning address"
          hint={lud16Disabled
            ? 'Set a Lightning address above to enable.'
            : 'Auto-route to the address above.'}
          warning={lud16Conflict ? 'You picked Lightning earlier but cleared the address.' : ''}
        />
        <PaymentRadio
          name="payment_preference"
          checked={value === 'ecash'}
          onChange={() => onChange('ecash')}
          disabled={ecashDisabled}
          label="eCash"
          hint={ecashDisabled
            ? 'Requires a kind 10019 (mint preference) published from another client.'
            : 'Pay via your trusted Cashu mints.'}
          warning={ecashConflict ? 'Your mint-preference event is no longer reachable.' : ''}
        />
      </div>

      {!loaded && (
        <span className="text-[11px] text-neutral-700 block">Loading current preference…</span>
      )}
    </div>
  )
}

function PaymentRadio({ name, checked, onChange, disabled, label, hint, warning }) {
  return (
    <label className={`flex items-start gap-2 px-3 py-2 rounded border ${
      checked
        ? 'border-purple-700 bg-purple-950/20'
        : 'border-neutral-800 hover:border-neutral-700'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} transition-colors`}>
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 accent-purple-600"
      />
      <span className="flex-1 min-w-0">
        <span className="text-xs text-neutral-200 block">{label}</span>
        <span className="text-[11px] text-neutral-500 block mt-0.5">{hint}</span>
        {warning && (
          <span className="text-[11px] text-amber-400 block mt-0.5">{warning}</span>
        )}
      </span>
    </label>
  )
}

/**
 * NIP-89 / kind 31989 — recommend a checkout app for buyers viewing
 * this seller's kind 30402 listings. Pure infrastructure: lets the
 * seller paste a kind-31990 naddr (or raw `31990:pubkey:dtag` coord),
 * publishes the recommendation event, and renders the current state.
 *
 * No curated dropdown of "known" marketplace apps yet — verifying each
 * app's actual 31990 naddr is a manual step (see project memory). The
 * paste-your-own input is honest about that gap and still works for
 * the power-user case.
 */
function CheckoutAppField({ pubkey }) {
  const [input, setInput] = useState('')
  const [relayHint, setRelayHint] = useState('')
  const [loadedHandlers, setLoadedHandlers] = useState(null)  // null = unloaded; [] = loaded but empty
  const [loadedEventId, setLoadedEventId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  // Seed from any existing recommendation on mount. Keeps the editor
  // honest about current state — the seller can see what's published
  // and either keep it or replace it.
  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    ;(async () => {
      const r = await fetchCheckoutAppRecommendation(pubkey)
      if (cancelled) return
      if (r) {
        setLoadedHandlers(r.handlers)
        setLoadedEventId(r.event?.id || null)
      } else {
        setLoadedHandlers([])
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  async function handleSave() {
    setError('')
    const parsed = parseAppHandlerInput(input)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    // Reject any user-typed relay hint that isn't wss://. parseAppHandlerInput
    // already filtered the embedded naddr hint; this gate covers the manual
    // textbox so a paste of "http://attacker.example" doesn't sneak through.
    const typedHint = relayHint.trim()
    if (typedHint && !isValidRelayHint(typedHint)) {
      setError('Relay hint must be a wss:// URL')
      return
    }
    setBusy(true)
    try {
      const effectiveRelay = typedHint || parsed.relayHint || ''
      const result = await publishCheckoutAppRecommendation({
        handlers: [{ coord: parsed.coord, relayHint: effectiveRelay, platform: 'web' }],
      })
      // Optimistic local update so the "Currently recommending" line
      // reflects the just-saved choice without another fetch.
      setLoadedHandlers([{ coord: parsed.coord, relayHint: effectiveRelay, platform: 'web' }])
      setLoadedEventId(result.eventId)
      setInput('')
      setRelayHint('')
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      setError(e?.message || 'Publish failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleClear() {
    if (!loadedEventId) return
    setBusy(true)
    setError('')
    try {
      await deleteCheckoutAppRecommendation(loadedEventId)
      setLoadedHandlers([])
      setLoadedEventId(null)
    } catch (e) {
      setError(e?.message || 'Clear failed')
    } finally {
      setBusy(false)
    }
  }

  const hasExisting = Array.isArray(loadedHandlers) && loadedHandlers.length > 0

  return (
    <div className="space-y-2 pt-2 border-t border-neutral-800">
      <div>
        <span className="text-xs text-neutral-400 block">Checkout app (optional)</span>
        <span className="text-[11px] text-neutral-600 block mt-0.5">
          Recommend a Nostr marketplace app to handle checkout for your
          listings. Buyers' clients can route them there automatically.
          Publishes a NIP-89 / kind 31989 event.
        </span>
      </div>

      {hasExisting && (
        <div className="px-3 py-2 rounded border border-neutral-800 bg-neutral-900/40">
          <p className="text-[11px] text-neutral-500 mb-1">Currently recommending:</p>
          {loadedHandlers.map((h, i) => (
            <div key={i} className="text-[11px] font-mono text-neutral-300 break-all">
              {h.coord}
              {h.relayHint && (
                <span className="text-neutral-600"> · via {h.relayHint}</span>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={handleClear}
            disabled={busy}
            className="mt-2 text-[11px] text-rose-400 hover:text-rose-200 transition-colors disabled:opacity-50"
          >
            Clear recommendation
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        <input
          type="search"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="naddr1… or 31990:pubkey:dtag"
          className={`${inputCls} font-mono text-xs`}
        />
        <input
          type="search"
          value={relayHint}
          onChange={e => setRelayHint(e.target.value)}
          placeholder="Relay hint (optional, e.g. wss://relay.example.com)"
          className={`${inputCls} font-mono text-xs`}
        />
        <p className="text-[11px] text-neutral-600">
          Find an app's identifier from its docs or by browsing kind
          31990 events on a Nostr explorer. We don't ship a curated
          list yet — paste the one you trust.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        {error && <span className="text-[11px] text-red-400 mr-auto">{error}</span>}
        {savedFlash && <span className="text-[11px] text-emerald-400 mr-auto">✓ Published</span>}
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !input.trim()}
          className="text-[11px] px-2.5 py-1 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 transition-colors disabled:opacity-50"
        >
          {busy ? 'Publishing…' : (hasExisting ? 'Replace recommendation' : 'Set recommendation')}
        </button>
      </div>
    </div>
  )
}
