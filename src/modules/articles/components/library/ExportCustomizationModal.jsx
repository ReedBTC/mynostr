/**
 * ExportCustomizationModal — pre-export customization step for the
 * chapterized .epub / .md flows.
 *
 * Sits between "user clicks Export" and the actual export call. Lets
 * the user override title/subtitle/author, pick a cover image (local
 * file with optional Blossom upload, or paste a URL), choose format,
 * toggle TOC and credits page, and edit the curator attribution.
 *
 * Defaults are populated from props so a user who just wants the
 * existing behavior taps Export and is done — no required fields.
 *
 * Single-article exports (the per-article three-dot Export .md / .epub)
 * deliberately do NOT go through this modal — those auto-derive
 * metadata from the article event itself.
 *
 * Calls back via:
 *   onExport({ format, options }) where options matches the shape
 *   exportChapterizedEpub / exportChapterizedMd accept (title,
 *   subtitle, author, coverSource, includeToc, includeCredits,
 *   curatedBy, curatedDate).
 */
import { useEffect, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { uploadToBlossom } from '../../../../lib/blossom.js'
import { searchUsers, fetchProfiles } from '../../../../lib/primal.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import { Z } from '../../../../lib/zIndex.js'

const MAX_COVER_BYTES = 5 * 1024 * 1024 // 5 MB — covers don't need to be huge
const CURATOR_DEBOUNCE_MS = 350

// Attribute set spread onto every plain text input in the modal to
// stop browser password managers (LastPass especially) from latching
// on. Three layers because no single hint is universally honored:
//   - autoComplete="off" — standard, ignored by most modern browsers
//     for autofill but still suppresses some heuristics
//   - data-lpignore="true" — LastPass-specific opt-out
//   - data-form-type="other" — generic password-manager category hint
//     that signals "this isn't login or signup"
const PASSWORD_MANAGER_OPT_OUT = {
  autoComplete: 'off',
  'data-lpignore': 'true',
  'data-form-type': 'other',
}

export default function ExportCustomizationModal({
  open,
  onClose,
  onExport,
  // Suggested defaults pulled from the trigger context.
  defaultTitle = 'Reading List',
  defaultArticleCount = 0,
  // Pre-selected format — caller's "Combined .md" vs "Combined .epub"
  // button decides which radio is on at open. User can still flip
  // inside the modal.
  defaultFormat = 'epub',
  // Session user — used to pre-fill the curator field. Pass null
  // when the user isn't logged in (curator section hides).
  sessionUser = null,
}) {
  // ── Form state ─────────────────────────────────────────────────────
  const [format, setFormat] = useState(defaultFormat) // 'epub' | 'md'
  const [title, setTitle] = useState(defaultTitle)
  const [subtitle, setSubtitle] = useState('')
  const [includeToc, setIncludeToc] = useState(true)
  const [includeCredits, setIncludeCredits] = useState(true)
  const [includeCuratedBy, setIncludeCuratedBy] = useState(true)
  // Author state — separate from the curator. Drives `<dc:creator>` in
  // the EPUB metadata, which is what reader apps (Apple Books, Calibre,
  // Readium) display under "Author" in their library views. Uses the
  // same picker shape as the curator so users can type freely or pick
  // a real Nostr identity, but only the display name lands in the
  // EPUB metadata — npub is dropped because EPUB's `<dc:creator>` has
  // no place to put a profile URL.
  const sessionDisplayName = sessionUser?.profile?.displayName || sessionUser?.profile?.name || ''
  // Author defaults to blank — for curated collections the EPUB creator
  // is rarely the curator (the chapters carry their own per-article
  // bylines), and pre-filling the session name silently leaks it onto
  // every export. Blank-by-default lets the user opt in by typing.
  const [author, setAuthor] = useState({ name: '', npub: '', picture: '' })
  // "Various" — common case for curated collections where there's no
  // single author. When checked, the author field is greyed out and
  // the literal string "Various" is used as the EPUB creator. Reader
  // apps render this verbatim, which is the convention for anthologies.
  const [authorVarious, setAuthorVarious] = useState(false)
  // Curator state: name is always editable text. `npub` is set when the
  // user picks a Nostr-linked match from the lookup dropdown — cleared
  // whenever they edit the name freehand, since a name + a stale npub
  // would be inconsistent. Defaults to the session user.
  const [curator, setCurator] = useState({
    name: sessionDisplayName,
    npub: sessionUser?.npub || '',
    picture: sessionUser?.profile?.image || sessionUser?.profile?.picture || '',
  })
  const [includeDate, setIncludeDate] = useState(true)

  // ── Cover state ────────────────────────────────────────────────────
  // The two cover inputs (file picker + URL paste) are mutually
  // exclusive — one being set clears the other. We track them in
  // separate state so a user editing one doesn't accidentally lose
  // their pick in the other while typing.
  const [coverFile, setCoverFile] = useState(null)         // File
  const [coverFilePreviewUrl, setCoverFilePreviewUrl] = useState(null) // blob: URL
  const [coverUrl, setCoverUrl] = useState('')             // pasted URL
  const [coverError, setCoverError] = useState('')
  // "Also save to Blossom" — only meaningful when a file is picked
  // AND the user is logged in (Blossom auth signs an event).
  const [saveToBlossom, setSaveToBlossom] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Export-in-progress + export-error state. Modal stays open during
  // the export so any error (CORS-blocked cover URL, relay fetch
  // failure on chapter resolution, etc.) surfaces in the modal where
  // the user can adjust inputs and retry — closing on click would
  // hide the failure and force them to reopen + re-enter everything.
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const fileInputRef = useRef(null)
  // Any in-flight async work that must block close.
  const inFlight = uploading || exporting

  // ── Reset on open so a previous run's state doesn't ghost in ───────
  useEffect(() => {
    if (!open) return
    setFormat(defaultFormat)
    setTitle(defaultTitle)
    setSubtitle('')
    setIncludeToc(true)
    setIncludeCredits(true)
    setIncludeCuratedBy(true)
    setAuthor({ name: '', npub: '', picture: '' })
    setAuthorVarious(false)
    setCurator({
      name: sessionDisplayName,
      npub: sessionUser?.npub || '',
      picture: sessionUser?.profile?.image || sessionUser?.profile?.picture || '',
    })
    setIncludeDate(true)
    setCoverFile(null)
    setCoverUrl('')
    setCoverError('')
    setSaveToBlossom(false)
    setUploading(false)
    setExporting(false)
    setExportError('')
    if (coverFilePreviewUrl) URL.revokeObjectURL(coverFilePreviewUrl)
    setCoverFilePreviewUrl(null)
  // Intentionally exclude coverFilePreviewUrl: revoking the prior url
  // is part of the reset, but we don't want this effect re-firing
  // every time the user picks a new file (that path manages its own
  // revoke).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTitle, defaultFormat, sessionUser?.pubkey])

  // ── Esc closes / lock body scroll while open ───────────────────────
  // Esc is blocked while inFlight so a stray keypress can't close the
  // modal mid-upload-or-export. Same gate as the X / Cancel buttons.
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape' && !inFlight) onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose, inFlight])

  // Revoke any leftover blob URL when unmounting.
  useEffect(() => () => {
    if (coverFilePreviewUrl) URL.revokeObjectURL(coverFilePreviewUrl)
  }, [coverFilePreviewUrl])

  function handlePickFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setCoverError('')
    if (!file.type?.startsWith('image/')) {
      setCoverError('Please pick an image file (PNG, JPG, WebP).')
      e.target.value = ''
      return
    }
    if (file.size > MAX_COVER_BYTES) {
      setCoverError(`Image is too large — max ${Math.round(MAX_COVER_BYTES / 1024 / 1024)} MB.`)
      e.target.value = ''
      return
    }
    // Selecting a file clears any URL paste — they're mutually exclusive.
    setCoverUrl('')
    if (coverFilePreviewUrl) URL.revokeObjectURL(coverFilePreviewUrl)
    const blobUrl = URL.createObjectURL(file)
    setCoverFile(file)
    setCoverFilePreviewUrl(blobUrl)
  }

  function clearCoverFile() {
    if (coverFilePreviewUrl) URL.revokeObjectURL(coverFilePreviewUrl)
    setCoverFile(null)
    setCoverFilePreviewUrl(null)
    setSaveToBlossom(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleCoverUrlChange(value) {
    setCoverUrl(value)
    setCoverError('')
    // Pasting a URL clears any file pick.
    if (value && coverFile) clearCoverFile()
  }

  // Returns the coverSource arg to pass to the export functions.
  // Handles the optional Blossom upload step before resolving.
  async function resolveCoverSource() {
    if (coverFile) {
      if (saveToBlossom) {
        setUploading(true)
        try {
          const url = await uploadToBlossom(coverFile)
          return { url }
        } finally {
          setUploading(false)
        }
      }
      // Local-only path: pass the File as-is. epub.js mints a blob: URL.
      return { blob: coverFile }
    }
    if (coverUrl) {
      const trimmed = coverUrl.trim()
      if (!trimmed) return null
      if (!isSafeUrl(trimmed)) {
        throw new Error('Cover URL must start with http:// or https://')
      }
      return { url: trimmed }
    }
    return null
  }

  async function handleExport() {
    setCoverError('')
    setExportError('')
    let coverSource
    try {
      coverSource = await resolveCoverSource()
    } catch (err) {
      setCoverError(err.message || 'Failed to upload cover image.')
      return
    }
    const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD UTC
    const curatedBy = (includeCuratedBy && curator.name.trim())
      ? {
          name: curator.name.trim(),
          npub: curator.npub || '',
        }
      : null
    const curatedDate = includeDate ? today : null
    // EPUB <dc:creator> resolution: "Various" overrides everything when
    // checked (anthology convention); otherwise the picked / typed
    // author name. Only the display name goes into the EPUB metadata —
    // EPUB's <dc:creator> has no field for a profile URL.
    const finalAuthor = authorVarious
      ? 'Various'
      : (author.name.trim() || '')

    setExporting(true)
    try {
      await onExport({
        format,
        options: {
          title:          title.trim() || defaultTitle,
          subtitle:       subtitle.trim(),
          author:         finalAuthor,
          coverSource,
          includeToc,
          includeCredits,
          curatedBy,
          curatedDate,
        },
      })
      // Success — close ourselves. (The caller can also force-close
      // via onClose, but explicitly calling here keeps the success
      // path tidy whether or not the caller decides to.)
      onClose()
    } catch (err) {
      // Stay open so the user can fix their inputs and retry. The
      // most common error class is a CORS-blocked cover URL — surfaced
      // by generateCoverBlob via requireImage. Place the error in
      // exportError so it renders as a banner above the actions row.
      setExportError(err?.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  if (!open) return null

  const canBlossom = !!sessionUser?.pubkey && !sessionUser?.readOnly
  const previewUrl = coverFilePreviewUrl || (coverUrl.trim() && isSafeUrl(coverUrl.trim()) ? coverUrl.trim() : null)

  return (
    <div
      // Click-away-to-close intentionally NOT wired here. A user typing
      // a long title or pasting a URL shouldn't lose state to a stray
      // tap on the backdrop. Close paths are explicit: the X button in
      // the corner and the Cancel button in the action row (plus Esc).
      className={`fixed inset-0 bg-black/70 flex items-center justify-center ${Z.modal} p-4 overflow-y-auto`}
      role="dialog"
      aria-modal="true"
      aria-label="Customize export"
    >
      <div
        className={`relative bg-neutral-950 border border-neutral-800 rounded-lg shadow-2xl w-full max-w-lg my-8 ${Z.modalContent}`}
      >
        <button
          type="button"
          onClick={inFlight ? undefined : onClose}
          disabled={inFlight}
          className="absolute top-2 right-2 text-neutral-400 hover:text-neutral-100 p-2 rounded transition-colors disabled:opacity-30"
          aria-label="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-base font-medium text-neutral-100">Customize export</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              {defaultArticleCount} article{defaultArticleCount !== 1 ? 's' : ''} selected
            </p>
          </div>

          {/* ── Format ────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-neutral-500">Format</label>
            <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5">
              {[
                { key: 'epub', label: 'EPUB' },
                { key: 'md',   label: 'Markdown' },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setFormat(opt.key)}
                  className={`text-xs px-3 py-1 rounded-full transition-colors ${
                    format === opt.key
                      ? 'bg-purple-700 text-white'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Title / Subtitle ─────────────────────────────────
              Author field removed deliberately — each chapter has
              its own original author baked into the credits page,
              and "compiled by" is captured by the curator field
              below. A separate top-level Author was redundant. */}
          <Field label="Title">
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={defaultTitle}
              {...PASSWORD_MANAGER_OPT_OUT}
              className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 text-sm focus:outline-none focus:border-purple-500"
            />
          </Field>
          <Field label="Subtitle (optional)">
            <input
              type="text"
              value={subtitle}
              onChange={e => setSubtitle(e.target.value)}
              placeholder="A short description for the cover"
              {...PASSWORD_MANAGER_OPT_OUT}
              className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 text-sm focus:outline-none focus:border-purple-500"
            />
          </Field>

          {/* ── Author ────────────────────────────────────────────
              EPUB <dc:creator>. Same Nostr-lookup picker as the
              curator field below — pick a real user or type a
              freeform name. The "Various" checkbox is the standard
              convention for anthologies / multi-author curated
              collections; when on, the picker greys out and the
              literal string "Various" is used. */}
          <Field label="Author">
            <div className="space-y-2">
              <CuratorPicker
                value={author}
                onChange={setAuthor}
                disabled={authorVarious}
                placeholder='Type a name, paste an npub, or check "Various"'
              />
              <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={authorVarious}
                  onChange={e => setAuthorVarious(e.target.checked)}
                  className="accent-purple-600"
                />
                <span>Various — for anthologies / multi-author collections</span>
              </label>
            </div>
          </Field>

          {/* ── Cover image ──────────────────────────────────────── */}
          <Field label={`Cover image${format === 'md' ? ' (EPUB only — ignored for Markdown)' : ''}`}>
            <div className="flex gap-3 items-start">
              <div className="w-20 h-28 rounded border border-neutral-700 bg-neutral-900 flex items-center justify-center overflow-hidden shrink-0">
                {previewUrl ? (
                  // eslint-disable-next-line jsx-a11y/img-redundant-alt
                  <img
                    src={previewUrl}
                    alt="Cover preview"
                    className="w-full h-full object-cover"
                    onError={() => setCoverError('Could not load that image.')}
                  />
                ) : (
                  <span className="text-[10px] text-neutral-600 text-center px-2">
                    Gradient<br/>fallback
                  </span>
                )}
              </div>

              <div className="flex-1 space-y-2 min-w-0">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition-colors"
                  >
                    Upload file
                  </button>
                  {(coverFile || coverUrl) && (
                    <button
                      type="button"
                      onClick={() => { clearCoverFile(); setCoverUrl('') }}
                      className="text-xs px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-400 border border-neutral-700 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handlePickFile}
                    className="hidden"
                  />
                </div>
                <input
                  type="text"
                  value={coverUrl}
                  onChange={e => handleCoverUrlChange(e.target.value)}
                  placeholder="Or paste an image URL (Blossom, etc)"
                  {...PASSWORD_MANAGER_OPT_OUT}
                  className="w-full px-2.5 py-1.5 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 text-xs focus:outline-none focus:border-purple-500 placeholder-neutral-600"
                />
                {coverFile && canBlossom && (
                  <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveToBlossom}
                      onChange={e => setSaveToBlossom(e.target.checked)}
                      className="accent-purple-600"
                    />
                    <span>Also save to Blossom (so you can reuse this URL)</span>
                  </label>
                )}
              </div>
            </div>
            {coverError && (
              <p className="text-[11px] text-red-400 mt-1.5">{coverError}</p>
            )}
          </Field>

          {/* ── Toggles ──────────────────────────────────────────── */}
          <div className="space-y-2 pt-1">
            <Toggle
              label="Include hyperlinked TOC"
              checked={includeToc}
              onChange={setIncludeToc}
            />
            <Toggle
              label="Include credits page"
              hint="Front-matter page with curator info, per-article naddr / view links, and a short About-Nostr blurb."
              checked={includeCredits}
              onChange={setIncludeCredits}
            />
            {includeCredits && (
              <div className="ml-6 space-y-2.5 pl-3 border-l border-neutral-800">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={includeCuratedBy}
                    onChange={e => setIncludeCuratedBy(e.target.checked)}
                    className="accent-purple-600 mt-1.5"
                    id="export-cb-curatedby"
                  />
                  <div className="flex-1 min-w-0">
                    <label htmlFor="export-cb-curatedby" className="block text-xs text-neutral-400 cursor-pointer mb-1">
                      Curated by
                    </label>
                    <CuratorPicker
                      value={curator}
                      onChange={setCurator}
                      disabled={!includeCuratedBy}
                    />
                  </div>
                </div>
                <Toggle
                  label={`Include date (${new Date().toISOString().split('T')[0]})`}
                  checked={includeDate}
                  onChange={setIncludeDate}
                  small
                />
              </div>
            )}
          </div>

          {/* ── Error banner ─────────────────────────────────────
              Surfaces export failures (CORS-blocked cover URL,
              network errors during chapter resolution, signer
              issues, etc) so the user can adjust inputs and retry
              without reopening the modal. */}
          {exportError && (
            <div className="px-3 py-2 rounded border border-red-900/60 bg-red-950/20 text-red-300 text-xs leading-snug">
              {exportError}
            </div>
          )}

          {/* ── Actions ──────────────────────────────────────────── */}
          <div className="flex justify-end gap-2 pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={inFlight}
              className="px-4 py-2 rounded text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={inFlight}
              className="px-4 py-2 rounded text-sm bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50 transition-colors inline-flex items-center gap-2"
            >
              {inFlight && (
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
              )}
              {uploading ? 'Uploading cover…' : exporting ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * CuratorPicker — text input for the curator's display name with an
 * optional Nostr-lookup dropdown. The user can:
 *
 *   • Type any free-form name and leave it (npub stays empty — the
 *     credits page renders just a name without a profile link).
 *   • Type a name → wait for the dropdown of Primal user-search
 *     matches → click a match to attach that user's npub. Typing
 *     after a match clears the npub link, since editing a name with
 *     a stale npub attached would publish a credits page that
 *     contradicts itself.
 *   • Paste a bare npub or nprofile to resolve a single user.
 *
 * Selecting a match shows a tiny "linked to {truncated-npub}" badge
 * under the input so the user knows the credits page will hyperlink
 * the name to that profile on mynostr.
 */
function CuratorPicker({ value, onChange, disabled, placeholder = 'Type a name or paste an npub' }) {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef(null)
  const reqIdRef = useRef(0)
  const containerRef = useRef(null)

  // Outside click closes the dropdown. Pointerdown+capture catches
  // taps on portaled overlays before their own handlers fire.
  useEffect(() => {
    function onDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])

  useEffect(() => () => clearTimeout(debounceRef.current), [])

  function handleNameChange(e) {
    const text = e.target.value
    // Editing the name clears any prior npub link — they can't be
    // out of sync. Picture goes too since it was tied to the linked
    // identity. Both come back if the user picks a new match.
    onChange({ name: text, npub: '', picture: '' })
    clearTimeout(debounceRef.current)
    const trimmed = text.trim()
    if (!trimmed) {
      setItems([])
      setOpen(false)
      setSearching(false)
      return
    }
    debounceRef.current = setTimeout(() => runLookup(trimmed), CURATOR_DEBOUNCE_MS)
  }

  async function runLookup(query) {
    const reqId = ++reqIdRef.current
    setSearching(true)
    try {
      const lower = query.toLowerCase()
      // Bech32 path — paste an npub/nprofile and we resolve it to
      // a single matched user.
      if (lower.startsWith('npub1') || lower.startsWith('nprofile1')) {
        try {
          const decoded = nip19.decode(query)
          const pubkey = decoded.type === 'npub'
            ? decoded.data
            : decoded.type === 'nprofile' ? decoded.data.pubkey : null
          if (!pubkey) {
            if (reqIdRef.current === reqId) {
              setItems([])
              setOpen(false)
            }
            return
          }
          const profiles = await fetchProfiles([pubkey])
          if (reqIdRef.current !== reqId) return
          const p = profiles.get(pubkey)
          let npub = ''
          try { npub = nip19.npubEncode(pubkey) } catch {}
          setItems([{
            pubkey,
            npub,
            name: p?.display_name || p?.name || 'Unknown',
            picture: p?.picture || '',
          }])
          setOpen(true)
          return
        } catch {
          if (reqIdRef.current === reqId) {
            setItems([])
            setOpen(false)
          }
          return
        }
      }
      // Free-text path — Primal user search. Always shown as
      // suggestions; user can ignore and keep their typed text as
      // the freeform curator name.
      const results = await searchUsers(query, 6)
      if (reqIdRef.current !== reqId) return
      const mapped = results.map(u => {
        let npub = ''
        try { npub = nip19.npubEncode(u.pubkey) } catch {}
        return {
          pubkey: u.pubkey,
          npub,
          name: u.name || '',
          picture: u.picture || '',
        }
      }).filter(r => r.npub)
      setItems(mapped)
      setOpen(mapped.length > 0)
    } catch {
      if (reqIdRef.current !== reqId) return
      setItems([])
      setOpen(false)
    } finally {
      if (reqIdRef.current === reqId) setSearching(false)
    }
  }

  function handlePick(item) {
    onChange({ name: item.name || '', npub: item.npub, picture: item.picture })
    setItems([])
    setOpen(false)
  }

  const linkedBadge = !!value.npub

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value.name}
        onChange={handleNameChange}
        onFocus={() => { if (items.length > 0) setOpen(true) }}
        disabled={disabled}
        placeholder={placeholder}
        {...PASSWORD_MANAGER_OPT_OUT}
        className="w-full px-2 py-1 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 text-xs focus:outline-none focus:border-purple-500 disabled:opacity-50 placeholder-neutral-600"
      />
      {linkedBadge && (
        <p className="text-[10px] text-purple-400 mt-1 truncate font-mono" title={value.npub}>
          ✓ Linked to {truncateNpub(value.npub)}
        </p>
      )}
      {open && items.length > 0 && !disabled && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-10 overflow-hidden max-h-60 overflow-y-auto">
          {items.map(item => (
            <button
              key={item.pubkey}
              type="button"
              onMouseDown={e => { e.preventDefault(); handlePick(item) }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-neutral-700 transition-colors"
            >
              {item.picture && isSafeUrl(item.picture) ? (
                <img
                  src={item.picture}
                  alt=""
                  className="w-6 h-6 rounded-full object-cover bg-neutral-900 shrink-0"
                  onError={e => { e.target.style.display = 'none' }}
                />
              ) : (
                <span className="w-6 h-6 rounded-full bg-neutral-900 shrink-0" />
              )}
              <span className="flex-1 min-w-0">
                <span className="block text-xs text-neutral-100 truncate">{item.name || 'Unknown'}</span>
                <span className="block text-[10px] text-neutral-500 truncate font-mono">{truncateNpub(item.npub)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {searching && !open && (
        <p className="text-[10px] text-neutral-600 mt-1">Searching…</p>
      )}
    </div>
  )
}

// Tiny inline truncator. (Could share with utils.js's truncateNpub
// but a 30-line component keeping its own one-liner is fine.)
function truncateNpub(npub) {
  if (!npub) return ''
  if (npub.length <= 16) return npub
  return `${npub.slice(0, 10)}…${npub.slice(-6)}`
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs uppercase tracking-wider text-neutral-500">{label}</label>
      {children}
    </div>
  )
}

function Toggle({ label, hint, checked, onChange, small = false }) {
  return (
    <div>
      <label className={`flex items-center gap-2 cursor-pointer ${small ? 'text-xs' : 'text-sm'}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="accent-purple-600"
        />
        <span className="text-neutral-300">{label}</span>
      </label>
      {hint && (
        <p className="ml-6 text-[11px] text-neutral-500 leading-snug mt-0.5">{hint}</p>
      )}
    </div>
  )
}
