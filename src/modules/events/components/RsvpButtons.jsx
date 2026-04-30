/**
 * RsvpButtons — three-state RSVP toggle for the EventDetail page.
 * Tapping a status publishes a kind 31925 with that status; the same
 * d-tag (= target coordinate) means the relay replaces any prior RSVP
 * by this user for the same event. Tapping the currently-active state
 * is a no-op (could later become "withdraw RSVP" via kind 5; deferred
 * to Phase 3 under the same edit/delete umbrella).
 */
import { useState } from 'react'
import { useLoginModal } from '../../../components/LoginModalContext.jsx'
import { publishRsvp } from '../../../lib/eventPublish.js'
import { coordOf } from '../../../lib/eventTypes.js'

const STATUS_DEFS = [
  { id: 'accepted',  label: 'Going',     short: 'Going',     emoji: '✅' },
  { id: 'tentative', label: 'Maybe',     short: 'Maybe',     emoji: '🤔' },
  { id: 'declined',  label: 'Not going', short: 'Skip',      emoji: '🚫' },
]

export default function RsvpButtons({ parsed, sessionUser, currentStatus, onStatusChange }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const { openLogin } = useLoginModal()

  const isOwnEvent = sessionUser?.pubkey && sessionUser.pubkey === parsed?.pubkey

  async function handleClick(status) {
    if (busy) return
    if (!sessionUser) { openLogin(); return }
    if (currentStatus === status) return
    setBusy(status)
    setError('')
    try {
      await publishRsvp({
        targetCoord: coordOf(parsed),
        targetEventId: parsed.id,
        targetAuthor:  parsed.pubkey,
        status,
      })
      onStatusChange?.(status)
    } catch (e) {
      setError(e?.message || 'RSVP failed')
    } finally {
      setBusy('')
    }
  }

  if (isOwnEvent) {
    return (
      <div className="text-[11px] text-neutral-500 italic">
        You're the host of this event.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {STATUS_DEFS.map(s => {
          const active = currentStatus === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => handleClick(s.id)}
              disabled={busy === s.id}
              className={[
                'text-xs px-3 py-1.5 rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600 disabled:opacity-50',
                active
                  ? 'border-purple-700 bg-purple-950/50 text-purple-200'
                  : 'border-neutral-700 text-neutral-300 hover:border-purple-700/60 hover:text-purple-200',
              ].join(' ')}
            >
              <span className="mr-1.5">{s.emoji}</span>
              {busy === s.id ? '…' : s.label}
            </button>
          )
        })}
      </div>
      {error && <div className="text-[11px] text-rose-400">{error}</div>}
    </div>
  )
}
