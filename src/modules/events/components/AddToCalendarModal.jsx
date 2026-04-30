/**
 * AddToCalendarModal — pick which of the session user's kind 31924
 * calendars this event should belong to. Toggle membership per
 * calendar (each row is a checkbox), or create a brand-new calendar
 * via the inline form at the bottom.
 *
 * The modal mutates immediately on toggle — no batch "save" — so
 * users see the membership state of the current event update live
 * across calendars and can close at any point. Each toggle fires a
 * fresh kind-31924 publish (replaceable; relays drop the prior copy).
 */
import { useEffect, useState } from 'react'
import { Z } from '../../../lib/zIndex.js'
import { isSafeUrl } from '../../../lib/utils.js'
import { coordOf } from '../../../lib/eventTypes.js'
import { useEventCalendars } from '../../../lib/useEventCalendars.js'

export default function AddToCalendarModal({ parsed, sessionUser, onClose }) {
  const sessionPubkey = sessionUser?.pubkey || null
  const {
    calendars, loading, error, pending,
    addToCalendar, removeFromCalendar, createCalendar,
    containingCalendars,
  } = useEventCalendars(sessionPubkey)

  const eventCoord = coordOf(parsed)
  const memberships = new Set(containingCalendars(eventCoord))

  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleToggle(dTag) {
    if (pending || !eventCoord) return
    setActionError('')
    const isMember = memberships.has(dTag)
    const r = isMember
      ? await removeFromCalendar(dTag, eventCoord)
      : await addToCalendar(dTag, eventCoord)
    if (!r?.ok) setActionError(r?.error || 'Save failed — try again.')
  }

  async function handleCreate(e) {
    e?.preventDefault()
    const name = newName.trim()
    if (!name || creating || !eventCoord) return
    setCreateError('')
    setCreating(true)
    try {
      const r = await createCalendar({
        title: name,
        // Seed the new calendar with the current event already in it —
        // the user clicked "create" from this event's menu, so they
        // obviously want it added.
        eventRefs: [eventCoord],
      })
      if (!r?.ok) {
        setCreateError(r?.error || 'Create failed — try again.')
        return
      }
      setNewName('')
    } finally {
      setCreating(false)
    }
  }

  if (!sessionPubkey) {
    return (
      <Backdrop onClose={onClose}>
        <Card>
          <Header title="Add to calendar" onClose={onClose} />
          <p className="px-4 py-6 text-xs text-neutral-500 text-center">
            Sign in to save this event to a calendar.
          </p>
        </Card>
      </Backdrop>
    )
  }

  return (
    <Backdrop onClose={onClose}>
      <Card>
        <Header
          title="Add to calendar"
          subtitle="Toggle which of your calendars this event belongs to."
          onClose={onClose}
        />

        <div className="flex-1 overflow-auto">
          {loading && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">Loading your calendars…</p>
          )}
          {error && (
            <p className="text-xs text-red-400 px-4 py-6">{error}</p>
          )}
          {!loading && !error && calendars.length === 0 && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">
              You haven't created any calendars yet. Make one below.
            </p>
          )}
          {!loading && !error && calendars.length > 0 && (
            <ul className="divide-y divide-neutral-800">
              {calendars.map(({ decoded }) => {
                const isMember = memberships.has(decoded.dTag)
                return (
                  <li key={decoded.dTag}>
                    <button
                      type="button"
                      onClick={() => handleToggle(decoded.dTag)}
                      disabled={pending}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:opacity-50 ${
                        isMember ? 'bg-purple-950/25 hover:bg-purple-950/40' : 'hover:bg-neutral-800/60'
                      }`}
                    >
                      <CalendarThumbnail image={decoded.image} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-neutral-200 truncate">
                          {decoded.title || 'Untitled calendar'}
                        </p>
                        <p className="text-[10px] text-neutral-500 truncate">
                          {(decoded.eventRefs || []).length} event{(decoded.eventRefs || []).length === 1 ? '' : 's'}
                        </p>
                      </div>
                      <Checkbox checked={isMember} disabled={pending} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {actionError && (
            <p className="text-xs text-red-400 px-4 py-2">{actionError}</p>
          )}
        </div>

        <form
          onSubmit={handleCreate}
          className="flex-shrink-0 px-4 py-3 border-t border-neutral-800 space-y-2"
        >
          <label className="block text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
            New calendar
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); if (createError) setCreateError('') }}
              placeholder="e.g. Bitcoin meetups"
              maxLength={80}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              disabled={creating}
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-40 transition-colors inline-flex items-center gap-1.5"
            >
              {creating ? (
                <>
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  Creating…
                </>
              ) : 'Create + add'}
            </button>
          </div>
          {createError && (
            <p className="text-xs text-red-400">{createError}</p>
          )}
        </form>

        <div className="flex-shrink-0 px-4 py-3 border-t border-neutral-800 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors"
          >
            Done
          </button>
        </div>
      </Card>
    </Backdrop>
  )
}

function Backdrop({ children, onClose }) {
  return (
    <div
      className={`fixed inset-0 ${Z.modal} bg-black/60 flex items-center justify-center p-4`}
      onMouseDown={onClose}
    >
      {children}
    </div>
  )
}

function Card({ children }) {
  return (
    <div
      className={`bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden ${Z.modalContent}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

function Header({ title, subtitle, onClose }) {
  return (
    <div className="flex items-start justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0 gap-3">
      <div>
        <h2 className="text-sm font-semibold text-neutral-200">{title}</h2>
        {subtitle && (
          <p className="text-[11px] text-neutral-500 mt-0.5">{subtitle}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="text-neutral-500 hover:text-neutral-200 transition-colors text-xl leading-none p-1.5 -m-1.5"
        aria-label="Close"
      >✕</button>
    </div>
  )
}

function CalendarThumbnail({ image }) {
  if (image && isSafeUrl(image)) {
    return (
      <img
        src={image}
        alt=""
        className="w-10 h-10 rounded bg-neutral-800 border border-neutral-700 object-cover flex-shrink-0"
        onError={(e) => { e.currentTarget.style.display = 'none' }}
      />
    )
  }
  return (
    <div className="w-10 h-10 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-600 flex-shrink-0">
      <span className="text-sm" aria-hidden>🗓</span>
    </div>
  )
}

function Checkbox({ checked, disabled }) {
  return (
    <span
      aria-hidden
      className={`flex-shrink-0 w-4 h-4 rounded border transition-colors flex items-center justify-center ${
        checked
          ? 'bg-purple-600 border-purple-600 text-white'
          : 'bg-neutral-950 border-neutral-700 text-transparent'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M2 5 L4.5 7.5 L8 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}
