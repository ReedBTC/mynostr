import { useRef, useState } from 'react'
import { isSafeUrl } from '../../lib/utils.js'
import { publishProfile, PROFILE_FIELD_CAPS } from '../../lib/publishProfile.js'
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
      const { profileContent, usedFallbackRelays } = await publishProfile({ pubkey, edits: trimmed })
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
  'w-full bg-neutral-900 border border-neutral-700 focus:border-purple-600 rounded px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none'

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-400 block mb-1">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-neutral-600 block mt-1">{hint}</span>}
    </label>
  )
}
