/**
 * EventComposer — owner-only composer for kind 31922/31923 events.
 *
 * Mirrors the marketplace SellComposer chrome: full-pane width, an
 * action row with Import / Load from Nostr / Export, a publish-identity
 * banner (new vs replace), and a footer action bar. Single tz field
 * defaulting to the user's local zone. Custom slot-list time picker
 * (replaces the OS-native control). Nominatim-backed location
 * autocomplete (lat/lon → 'g' tag geohash on publish).
 *
 * The composer holds a single in-memory form. There's no multi-draft
 * tray (yet); auto-save lives in localStorage keyed by the session
 * pubkey so a refresh mid-edit doesn't lose work.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isSafeUrl, titleToSlug } from '../../../lib/utils.js'
import { uploadToBlossom } from '../../../lib/blossom.js'
import {
  emptyEventForm,
  eventToForm,
  fetchEventForLoader,
  formToEventTemplate,
  formToPublishShape,
  getUserTimezone,
  isEventFormMeaningful,
} from '../../../lib/eventForm.js'
import { publishCalendarEvent } from '../../../lib/eventPublish.js'
import TimePicker from './TimePicker.jsx'
import LocationAutocomplete from './LocationAutocomplete.jsx'
import LinkExistingEventModal from './LinkExistingEventModal.jsx'

// Common IANA tzids hoisted to the top of the dropdown so users in
// the most common zones don't have to scroll. The user's own resolved
// tz lives at the very top with a "(your tz)" hint.
const COMMON_TZIDS = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo', 'Europe/London',
  'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Athens',
  'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok',
  'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
]

const AUTOSAVE_KEY = (pubkey) => `mynostr_event_draft_${pubkey || 'anon'}`

// Match the cap used by CollectionEditModal and the Sell composer's
// photo upload. Blossom servers may also enforce; the client check is
// for fast feedback on absent-mindedly dropped raw photos.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export default function EventComposer({ sessionUser, ownerNpub }) {
  const navigate = useNavigate()
  const fileInputRef = useRef(null)
  const importInputRef = useRef(null)

  const pubkey = sessionUser?.pubkey || null

  // ── Form state ──────────────────────────────────────────────────────
  const [form, setForm] = useState(() => loadAutosave(pubkey))

  // Bump on wholesale snapshot replace (Import / Load from Nostr) so
  // child components keyed on this remount their internal state.
  const [replaceVersion, setReplaceVersion] = useState(0)

  // Autosave to localStorage. Skips while empty so a fresh-loaded
  // composer doesn't pin "anon" garbage in storage.
  useEffect(() => {
    if (!pubkey) return
    if (!isEventFormMeaningful(form)) {
      try { localStorage.removeItem(AUTOSAVE_KEY(pubkey)) } catch {}
      return
    }
    try { localStorage.setItem(AUTOSAVE_KEY(pubkey), JSON.stringify(form)) } catch {}
  }, [form, pubkey])

  // ── Action-row state ────────────────────────────────────────────────
  const [importError, setImportError] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [naddrInput, setNaddrInput] = useState('')
  const [naddrError, setNaddrError] = useState('')
  const [naddrLoading, setNaddrLoading] = useState(false)

  // ── Image upload state (URL paste OR Blossom upload) ────────────────
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState('')

  // ── Publish state ───────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Discard is two-click (arms red, second click clears form).
  const [discardArmed, setDiscardArmed] = useState(false)
  useEffect(() => {
    if (!discardArmed) return
    const id = setTimeout(() => setDiscardArmed(false), 4000)
    return () => clearTimeout(id)
  }, [discardArmed])

  const updateForm = useCallback((patch) => {
    setSubmitError('')
    setForm(f => ({ ...f, ...patch }))
  }, [])

  const replaceSnapshot = useCallback((next) => {
    setForm({ ...emptyEventForm(), ...next })
    setReplaceVersion(v => v + 1)
    setSubmitError('')
  }, [])

  // ── Action handlers ─────────────────────────────────────────────────

  const handleImportFile = useCallback(async (file) => {
    if (!file) return
    setImportError('')
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      setImportError('Please pick a .json file.')
      return
    }
    if (file.size > 1_000_000) {
      setImportError('File too large — 1 MB max.')
      return
    }
    setImportLoading(true)
    try {
      const text = await file.text()
      const ev = JSON.parse(text)
      const snapshot = eventToForm(ev)
      if (!snapshot) {
        setImportError('Not a kind 31922 / 31923 event.')
        return
      }
      // Strip dTag — JSON import is "use this as a template for a new
      // event," not "replace the original on Nostr." Load-from-Nostr is
      // the dTag-preserving path. Same convention the marketplace
      // composer uses.
      snapshot.dTag = ''
      snapshot.linkedEventTitle = ''
      replaceSnapshot(snapshot)
    } catch (e) {
      setImportError(`Invalid JSON: ${e?.message || 'parse failed'}`)
    } finally {
      setImportLoading(false)
    }
  }, [replaceSnapshot])

  const handleNaddrLoad = useCallback(async () => {
    const trimmed = naddrInput.trim()
    if (!trimmed) return
    setNaddrError('')
    setNaddrLoading(true)
    try {
      const r = await fetchEventForLoader(trimmed)
      if (r.ok) {
        replaceSnapshot(r.snapshot)
        setNaddrInput('')
      } else {
        setNaddrError(r.error || 'Load failed.')
      }
    } finally {
      setNaddrLoading(false)
    }
  }, [naddrInput, replaceSnapshot])

  const handleExport = useCallback(() => {
    if (!form.title?.trim()) return
    try {
      const ev = formToEventTemplate(form, { pubkey: pubkey || '' })
      const blob = new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const slug = titleToSlug(form.title) || 'event'
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // formToEventTemplate can throw on a half-empty form (e.g. no
      // start date). Swallow — Export is disabled until the form has
      // at least a title, but a user could click between keystrokes.
    }
  }, [form, pubkey])

  const handleDiscard = useCallback(() => {
    if (!discardArmed) {
      setDiscardArmed(true)
      return
    }
    setDiscardArmed(false)
    const fresh = emptyEventForm()
    setForm(fresh)
    setReplaceVersion(v => v + 1)
    setSubmitError('')
    if (pubkey) {
      try { localStorage.removeItem(AUTOSAVE_KEY(pubkey)) } catch {}
    }
  }, [discardArmed, pubkey])

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
    if (submitting) return
    setSubmitError('')
    let lowered
    try {
      lowered = formToPublishShape(form)
    } catch (err) {
      setSubmitError(err?.message || 'Form invalid.')
      return
    }
    setSubmitting(true)
    try {
      const { naddr } = await publishCalendarEvent(lowered)
      if (pubkey) {
        try { localStorage.removeItem(AUTOSAVE_KEY(pubkey)) } catch {}
      }
      const dest = naddr && ownerNpub ? `/${ownerNpub}/events/${naddr}` : `/${ownerNpub}/events`
      navigate(dest)
    } catch (err) {
      setSubmitError(err?.message || 'Publish failed.')
    } finally {
      setSubmitting(false)
    }
  }, [form, navigate, ownerNpub, pubkey, submitting])

  // ── Render ──────────────────────────────────────────────────────────

  if (!pubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        Sign in to create an event.
      </div>
    )
  }

  const userTz = getUserTimezone()
  const tzKnown = COMMON_TZIDS.includes(form.tzid) || form.tzid === userTz
  const tzList = []
  const seen = new Set()
  for (const tz of [userTz, ...COMMON_TZIDS]) {
    if (!tz || seen.has(tz)) continue
    seen.add(tz); tzList.push(tz)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Action row — full pane, contents centered to max-w-2xl to
          mirror the Sell composer. */}
      <div className="flex-shrink-0 px-4 pt-3 pb-4">
        <div className="max-w-2xl mx-auto flex items-center justify-end gap-2 flex-wrap">

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
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={importLoading}
            title="Import a kind 31922/31923 JSON file"
            className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            {importLoading ? '…' : 'Import'}
          </button>

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
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
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

          <button
            type="button"
            onClick={handleExport}
            disabled={!form.title?.trim() || !form.startDate}
            title="Export current event as JSON"
            className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            Export
          </button>
        </div>

        {(importError || naddrError) && (
          <div className="max-w-2xl mx-auto mt-1.5 text-xs text-red-400">
            {importError || naddrError}
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-auto" key={replaceVersion}>
        <div className="max-w-2xl mx-auto px-4 pb-6 space-y-5">

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
              // Stash the picked place's lat/lon as a *candidate* — only
              // promoted to a published `g` tag when the user opts in
              // via the checkbox below. Default off keeps the privacy
              // floor reasonable: a free-text address is one thing, a
              // 2.4m geohash pin is another.
              onPickPlace={({ lat, lon }) => updateForm({
                _pickedLat: Number.isFinite(lat) ? lat : null,
                _pickedLon: Number.isFinite(lon) ? lon : null,
              })}
            />
            <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer">
              <input
                type="checkbox"
                checked={!!form.geohash}
                // Enabled when either (a) a fresh suggestion is picked
                // (we have lat/lon to encode), or (b) a geohash is
                // already on the form (loaded from an existing event,
                // so the user can untick to remove it).
                disabled={
                  !form.geohash &&
                  (!Number.isFinite(form._pickedLat) || !Number.isFinite(form._pickedLon))
                }
                onChange={(e) => {
                  if (e.target.checked && Number.isFinite(form._pickedLat) && Number.isFinite(form._pickedLon)) {
                    // Encode at 7 chars (~76m, "block-level"). Anyone who
                    // really wants meter-precision can bump precision in
                    // a later toggle; default-low avoids dropping a pin
                    // on someone's home address by accident.
                    import('../../../lib/nominatim.js').then(m => {
                      const gh = m.encodeGeohash(form._pickedLat, form._pickedLon, 7)
                      updateForm({ geohash: gh || '' })
                    })
                  } else {
                    // Untick OR ticked-without-coords: clear the geohash.
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
        </div>
      </div>

      {/* ── Footer action bar ── */}
      <div className="flex-shrink-0 px-4 py-3 bg-neutral-950/90 backdrop-blur-sm border-t border-neutral-800">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 text-xs">
            {submitError
              ? <span className="text-red-400">{submitError}</span>
              : <span className="text-neutral-600">Draft saved automatically</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={submitting}
              className={discardArmed
                ? 'text-xs px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-40'
                : 'text-xs px-3 py-1.5 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors disabled:opacity-40'}
            >
              {discardArmed ? 'Click to confirm' : 'Discard'}
            </button>
            <button
              type="button"
              onClick={handlePublish}
              disabled={submitting}
              className="text-sm px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-40 transition-colors"
            >
              {submitting ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function loadAutosave(pubkey) {
  if (!pubkey) return emptyEventForm()
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY(pubkey))
    if (!raw) return emptyEventForm()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyEventForm()
    return { ...emptyEventForm(), ...parsed }
  } catch {
    return emptyEventForm()
  }
}

/**
 * Banner showing whether this draft will publish as a new event or
 * replace an existing one. Mirrors SellComposer's PublishIdentityBanner —
 * this is the explicit visibility surface for the dTag concept so users
 * always know which mode they're in.
 *
 * Two states keyed off form.dTag:
 *   • empty → green dot, "Will publish as new event." A "Replace
 *     Existing" button opens LinkExistingEventModal so the user can
 *     attach this draft's identity to one of their already-published
 *     events (publishing then replaces it on Nostr).
 *   • set   → blue dot, "Will Replace Event: <title>", with Change… +
 *     Unlink actions. Change reopens the picker; Unlink strips the
 *     dTag and converts back to a new-event flow.
 */
function PublishIdentityBanner({ form, updateForm, sessionUser }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const dTag = form.dTag || ''

  function handleLink({ dTag: pickedDTag, title: pickedTitle }) {
    if (pickedDTag) {
      // Stamp the linked event's title at link-time so the banner
      // continues to identify which existing event will be replaced
      // even after the user edits the draft's working title.
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
// were getting bypassed by their label-heuristic fallbacks (the
// "Title" and "Location" labels triggered fill prompts despite the
// data-lpignore opt-out). Browsers add a default clear-X button to
// search inputs; that's hidden via global CSS in styles/index.css so
// the field looks identical to a plain text input.
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
