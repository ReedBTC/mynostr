/**
 * EventComposer — presentational composer for one draft from the
 * multi-draft store (see useEventDrafts).
 *
 * Owns no draft state itself; the active draft + its mutators come in
 * from EventsModule, which holds the useEventDrafts hook. Editing
 * here flows through `onUpdateDraft(draft.id, fn)` so the tray and
 * composer stay in sync.
 *
 * Top action row: Mobile "Drafts (N)" chip + Import / Load from Nostr
 * / Export. Each acts on the *current* draft only — bulk operations
 * (Multi-JSON import, Export All, Publish All) live in the tray.
 *
 * Footer: Discard (two-click) + Publish. Successful publish flips the
 * body to a PublishedPanel showing the naddr + view links + a "New
 * event" button that deletes the draft and seeds a fresh one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isSafeUrl } from '../../../lib/utils.js'
import { uploadToBlossom } from '../../../lib/blossom.js'
import {
  emptyEventForm,
  getUserTimezone,
  COMMON_TZIDS,
  buildTzDropdownList,
} from '../../../lib/eventForm.js'
import TimePicker from './TimePicker.jsx'
import LocationAutocomplete from './LocationAutocomplete.jsx'
import LinkExistingEventModal from './LinkExistingEventModal.jsx'
import ImportExportDisclosure from '../../../components/ImportExportDisclosure.jsx'

// Match the cap used by CollectionEditModal and the Sell composer's
// photo upload. Blossom servers may also enforce; the client check is
// for fast feedback on absent-mindedly dropped raw photos.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export default function EventComposer({
  sessionUser,
  draft,                     // current draft from useEventDrafts
  onUpdateDraft,             // (id, fn) — atomic updater
  onDeleteDraft,             // (id)
  onPublish,                 // (id) — kicks publishOne
  onSingleImport,            // (file) — replaces current draft's snapshot. Returns {ok, error}
  onSingleExport,            // () — downloads current draft as JSON
  onLoadFromNostr,           // (input) — replaces current snapshot from naddr/nevent. Returns {ok, error}
  onOpenMobileDrafts,        // optional — mobile chip handler
  draftsCount = 1,           // for the mobile "Drafts (N)" chip
}) {
  const fileInputRef = useRef(null)

  // ── Top-row action state (per-current-draft single ops) ───────────
  const [importError,    setImportError]    = useState('')
  const [importLoading,  setImportLoading]  = useState(false)
  const [naddrInput,     setNaddrInput]     = useState('')
  const [naddrError,     setNaddrError]     = useState('')
  const [naddrLoading,   setNaddrLoading]   = useState(false)

  // ── Image upload (URL paste OR Blossom upload) ─────────────────────
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError,     setImageError]     = useState('')

  // ── Pre-publish validation error (separate from draft.publishError,
  // which represents an actual relay/sign failure). Cleared on next edit.
  const [validationError, setValidationError] = useState('')

  // Discard is two-click (arms red, second click confirms).
  const [discardArmed, setDiscardArmed] = useState(false)
  useEffect(() => {
    if (!discardArmed) return
    const id = setTimeout(() => setDiscardArmed(false), 4000)
    return () => clearTimeout(id)
  }, [discardArmed])

  // Reset per-draft local state when the draft changes (selection or
  // wholesale snapshot replace via Import / Load-from-Nostr). Keys off
  // both id and replaceVersion — the latter bumps even when id is
  // stable, so this catches both cases.
  useEffect(() => {
    setDiscardArmed(false)
    setValidationError('')
    setImportError('')
    setNaddrInput('')
    setNaddrError('')
  }, [draft?.id, draft?.replaceVersion])

  const form = draft?.snapshot || emptyEventForm()

  const updateForm = useCallback((patch) => {
    if (!draft || !onUpdateDraft) return
    setValidationError('')
    onUpdateDraft(draft.id, (d) => ({ ...d, snapshot: { ...d.snapshot, ...patch } }))
  }, [draft, onUpdateDraft])

  // ── Action handlers ─────────────────────────────────────────────────

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

  const handleImageUpload = useCallback(async (file) => {
    if (!file || imageUploading) return
    if (!file.type.startsWith('image/')) {
      setImageError('Pick an image file.')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(`Image too large — max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`)
      return
    }
    setImageUploading(true)
    setImageError('')
    try {
      const url = await uploadToBlossom(file)
      updateForm({ image: url })
    } catch (e) {
      setImageError(e?.message || 'Image upload failed')
    } finally {
      setImageUploading(false)
    }
  }, [imageUploading, updateForm])

  const handlePublish = useCallback(async () => {
    if (!draft) return
    setValidationError('')
    if (!form.title?.trim()) {
      setValidationError('Title is required.')
      return
    }
    if (!form.startDate) {
      setValidationError('Start date is required.')
      return
    }
    await onPublish(draft.id)
  }, [draft, form, onPublish])

  // ── Render ──────────────────────────────────────────────────────────

  if (!sessionUser?.pubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        Sign in to create an event.
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

  const userTz = getUserTimezone()
  const tzKnown = COMMON_TZIDS.includes(form.tzid) || form.tzid === userTz
  const tzList = buildTzDropdownList(userTz)

  const publishing = draft.status === 'publishing'
  const published  = draft.status === 'published'
  // Footer status precedence: validation > publish failure > idle.
  const footerError = validationError || (draft.status === 'failed' ? draft.publishError : '')

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Action row ── Hidden in published-success state since the
          panel takes over the body. */}
      <div className={`flex-shrink-0 px-4 pt-3 pb-4 ${published ? 'hidden' : ''}`}>
        <div className="max-w-2xl mx-auto space-y-2">

          {/* Mobile drafts chip. Desktop tray is permanently visible,
              so this stays mobile-only. */}
          {onOpenMobileDrafts && (
            <div className="md:hidden">
              <button
                type="button"
                onClick={onOpenMobileDrafts}
                className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
              >
                Drafts ({draftsCount})
              </button>
            </div>
          )}

          <ImportExportDisclosure
            acceptedFileTypes=".json,application/json"
            onImportFile={handleImportFile}
            importLabel="Upload JSON"
            importTitle="Import a kind 31922/31923 JSON file into the current draft"
            importLoading={importLoading}
            importError={importError}
            pasteIdValue={naddrInput}
            onPasteIdChange={(v) => { setNaddrInput(v); if (naddrError) setNaddrError('') }}
            onLoadId={handleNaddrLoad}
            pasteIdPlaceholder="naddr1… / nevent1…"
            loadLoading={naddrLoading}
            loadError={naddrError}
            exportLabel="Export JSON"
            onExport={onSingleExport}
            exportDisabled={!form.title?.trim() || !form.startDate}
            exportTitle="Export current event as JSON"
          />
        </div>
      </div>

      {/* ── Body ── */}
      {/* draft.id+replaceVersion as the body key remounts the form when
          the active draft changes OR when its snapshot is replaced
          wholesale (via Import / Load-from-Nostr). Children that
          lazy-init from props (TimePicker's slot scroll position,
          LocationAutocomplete's input value) stay in sync. */}
      <div className="flex-1 overflow-auto" key={`${draft.id}-${draft.replaceVersion || 0}`}>
        <div className="max-w-2xl mx-auto px-4 pb-6 space-y-5">

          {published ? (
            <PublishedPanel
              result={draft.publishResult}
              onAck={() => onDeleteDraft(draft.id)}
            />
          ) : (
            <>
              <PublishIdentityBanner
                form={form}
                updateForm={updateForm}
                sessionUser={sessionUser}
              />

              <Field label="Title *">
                <Input
                  value={form.title}
                  onChange={e => updateForm({ title: e.target.value })}
                  placeholder="What's this event called?"
                  autoFocus
                />
              </Field>

              <Field label="Summary">
                <Input
                  value={form.summary}
                  onChange={e => updateForm({ summary: e.target.value })}
                  placeholder="One-line tagline (optional)"
                  maxLength={140}
                />
              </Field>

              <Field label="Description">
                <textarea
                  value={form.description}
                  onChange={e => updateForm({ description: e.target.value })}
                  rows={5}
                  placeholder="Markdown OK. Add details, agenda, what to bring, etc."
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-form-type="other"
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 font-mono placeholder:text-neutral-600 focus:outline-none focus:border-purple-600 resize-y"
                />
              </Field>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={form.allDay}
                    onChange={e => updateForm({ allDay: e.target.checked })}
                    className="accent-purple-600"
                  />
                  All-day event (no specific time)
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Starts *">
                    <div className="flex gap-2">
                      <Input
                        type="date"
                        value={form.startDate}
                        onChange={e => updateForm({ startDate: e.target.value })}
                        className="flex-1"
                      />
                      {!form.allDay && (
                        <TimePicker
                          value={form.startTime}
                          onChange={v => updateForm({ startTime: v })}
                          className="w-32"
                        />
                      )}
                    </div>
                  </Field>
                  <Field label="Ends">
                    <div className="flex gap-2">
                      <Input
                        type="date"
                        value={form.endDate}
                        onChange={e => updateForm({ endDate: e.target.value })}
                        className="flex-1"
                      />
                      {!form.allDay && (
                        <TimePicker
                          value={form.endTime}
                          onChange={v => updateForm({ endTime: v })}
                          className="w-32"
                        />
                      )}
                    </div>
                  </Field>
                </div>

                {!form.allDay && (
                  <Field label="Timezone">
                    <select
                      value={tzKnown ? form.tzid : '__custom__'}
                      onChange={e => {
                        if (e.target.value !== '__custom__') updateForm({ tzid: e.target.value })
                        else updateForm({ tzid: '' })
                      }}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-purple-600"
                    >
                      {tzList.map(tz => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                      <option value="__custom__">Other (paste IANA id)…</option>
                    </select>
                    {!tzKnown && (
                      <Input
                        value={form.tzid}
                        onChange={e => updateForm({ tzid: e.target.value })}
                        placeholder="IANA tzid e.g. Africa/Cairo"
                        className="mt-2"
                      />
                    )}
                  </Field>
                )}
              </div>

              <Field label="Location">
                <LocationAutocomplete
                  value={form.location}
                  onChange={v => updateForm({ location: v })}
                  // Stash the picked place's lat/lon as a candidate;
                  // only promoted to a published `g` tag when the user
                  // opts in via the checkbox below.
                  onPickPlace={({ lat, lon }) => updateForm({
                    _pickedLat: Number.isFinite(lat) ? lat : null,
                    _pickedLon: Number.isFinite(lon) ? lon : null,
                  })}
                />
                <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!form.geohash}
                    disabled={
                      !form.geohash &&
                      (!Number.isFinite(form._pickedLat) || !Number.isFinite(form._pickedLon))
                    }
                    onChange={(e) => {
                      if (e.target.checked && Number.isFinite(form._pickedLat) && Number.isFinite(form._pickedLon)) {
                        // 7-char geohash ≈ 76m, "block-level". Default-low
                        // avoids accidentally pinning a home address.
                        import('../../../lib/nominatim.js').then(m => {
                          const gh = m.encodeGeohash(form._pickedLat, form._pickedLon, 7)
                          updateForm({ geohash: gh || '' })
                        })
                      } else {
                        updateForm({ geohash: '' })
                      }
                    }}
                    className="accent-purple-600"
                  />
                  <span>
                    Pin map location
                    {!form.geohash && !Number.isFinite(form._pickedLat) && (
                      <span className="text-neutral-600 ml-1">(pick a suggestion above first)</span>
                    )}
                  </span>
                </label>
              </Field>

              <Field label="Image">
                <div className="flex gap-2">
                  <Input
                    value={form.image}
                    onChange={e => updateForm({ image: e.target.value })}
                    placeholder="https://… or upload below"
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={imageUploading}
                    className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:border-purple-700/60 hover:text-purple-200 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-purple-600"
                  >
                    {imageUploading ? 'Uploading…' : 'Upload'}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) handleImageUpload(f)
                      e.target.value = ''
                    }}
                  />
                </div>
                {imageError && <div className="text-[11px] text-rose-400 mt-1">{imageError}</div>}
                {form.image && isSafeUrl(form.image) && (
                  <div className="mt-2 rounded overflow-hidden border border-neutral-800">
                    <img
                      src={form.image}
                      alt=""
                      className="block w-full h-auto"
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  </div>
                )}
              </Field>

              <Field label="Hashtags">
                <Input
                  value={form.hashtags}
                  onChange={e => updateForm({ hashtags: e.target.value })}
                  placeholder="bitcoin meetup nyc (space- or comma-separated)"
                />
              </Field>
            </>
          )}
        </div>
      </div>

      {/* ── Footer action bar ── Hidden in published-success state. */}
      {!published && (
        <div className="flex-shrink-0 px-4 py-3 bg-neutral-950/90 backdrop-blur-sm border-t border-neutral-800">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 text-xs">
              {footerError
                ? <span className="text-red-400">{footerError}</span>
                : <span className="text-neutral-600">Draft saved automatically</span>}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDiscard}
                disabled={publishing}
                className={discardArmed
                  ? 'text-xs px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-40'
                  : 'text-xs px-3 py-1.5 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors disabled:opacity-40'}
              >
                {discardArmed ? 'Click to confirm' : 'Discard'}
              </button>
              <button
                type="button"
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
    </div>
  )
}

// ── Published-success panel ────────────────────────────────────────────
// Mirrors SellComposer's PublishedPanel: shows the canonical naddr
// (with copy), the relay count, view links on njump / Plektos, and a
// "New event" button that calls onAck (wired by parent to deleteDraft
// so the next draft slot is fresh).
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
      // the user can still hand-copy the visible naddr text.
    }
  }

  return (
    <div className="bg-green-900/20 border border-green-800 rounded-lg p-4">
      <p className="text-green-400 font-medium text-sm mb-3">Published!</p>

      {naddr && (
        <div className="mb-2.5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">naddr</span>
            <button
              type="button"
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
        {naddr && (
          <a
            href={`https://plektos.app/event/${naddr}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 underline"
          >
            View on Plektos
          </a>
        )}
        {eventId && !naddr && (
          <code className="text-[10px] text-neutral-500 break-all">id: {eventId}</code>
        )}
      </div>

      {relays.length > 0 && (
        <p className="text-[10px] text-neutral-600 mt-2">
          Sent to {relays.length} relay{relays.length === 1 ? '' : 's'}
        </p>
      )}

      <button
        type="button"
        onClick={onAck}
        className="mt-4 w-full py-2 bg-purple-600 hover:bg-purple-500 rounded text-sm text-white font-medium transition-colors"
      >
        New event
      </button>
    </div>
  )
}

/**
 * Banner showing whether this draft will publish as a new event or
 * replace an existing one. Mirrors SellComposer's PublishIdentityBanner.
 *
 * Two states keyed off form.dTag:
 *   • empty → green dot, "Will publish as new event." A "Replace
 *     Existing" button opens LinkExistingEventModal so the user can
 *     attach this draft's identity to one of their already-published
 *     events.
 *   • set   → blue dot, "Will Replace Event: <title>", with Change… +
 *     Unlink actions.
 */
function PublishIdentityBanner({ form, updateForm, sessionUser }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const dTag = form.dTag || ''

  function handleLink({ dTag: pickedDTag, title: pickedTitle }) {
    if (pickedDTag) {
      updateForm({
        dTag: pickedDTag,
        linkedEventTitle: pickedTitle || '',
      })
    }
    setPickerOpen(false)
  }

  if (dTag) {
    const dTagDisplay = dTag.length > 32 ? dTag.slice(0, 32) + '…' : dTag
    const titleDisplay = form.linkedEventTitle?.trim()
      || form.title?.trim()
      || '(untitled)'
    return (
      <>
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-blue-900/50 bg-blue-950/25">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" aria-hidden />
          <div className="flex-1 min-w-0 text-xs">
            <p className="text-neutral-200 truncate">
              Will Replace Event: <span className="font-medium">{titleDisplay}</span>
            </p>
            <p className="text-[10px] text-neutral-500 truncate font-mono mt-0.5">
              d:{dTagDisplay}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              title="Pick a different event for this draft to replace"
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              Change…
            </button>
            <button
              type="button"
              onClick={() => updateForm({ dTag: '', linkedEventTitle: '' })}
              title="Strip the dTag so this draft publishes as a new event instead"
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              Unlink
            </button>
          </div>
        </div>
        {pickerOpen && (
          <LinkExistingEventModal
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
          <p className="text-neutral-200">Will publish as new event</p>
          <p className="text-[10px] text-neutral-500 mt-0.5">
            A new item will be generated on publish
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          title="Link this draft to an existing event — publishing will replace that event's content on Nostr"
          className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors flex-shrink-0"
        >
          Replace Existing
        </button>
      </div>
      {pickerOpen && (
        <LinkExistingEventModal
          sessionUser={sessionUser}
          currentDTag={dTag}
          onSelect={handleLink}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold">
        {label}
      </label>
      {children}
    </div>
  )
}

// Every input in this composer suppresses password-manager autofill.
// `type="search"` is the load-bearing line: LastPass / 1Password /
// Bitwarden all skip search inputs, where the data-attr hints alone
// were getting bypassed by their label-heuristic fallbacks. Browsers
// add a default clear-X button to search inputs; that's hidden via
// global CSS in styles/index.css so the field looks identical to a
// plain text input.
//
// Date pickers (type="date") still need to flow through, so callers
// that pass an explicit `type` win — the search default applies only
// when no type is specified by the caller.
function Input({ className = '', autoComplete, type, ...rest }) {
  return (
    <input
      type={type || 'search'}
      autoComplete={autoComplete || 'off'}
      data-lpignore="true"
      data-1p-ignore="true"
      data-form-type="other"
      {...rest}
      className={
        'w-full bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-purple-600 ' +
        className
      }
    />
  )
}
