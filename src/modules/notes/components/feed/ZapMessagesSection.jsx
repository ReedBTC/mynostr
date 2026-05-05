/**
 * ZapMessagesSection — collapsed-by-default disclosure under each
 * NoteCard that surfaces zap-with-message receipts on a note. Exists
 * because none of the major Nostr clients currently surface zap
 * comments at the per-note level — the signal is invisible.
 *
 * Lifecycle:
 *   1. Mount → IntersectionObserver attaches to a 1px sentinel.
 *   2. Card scrolls into viewport → fire fetchZapMessages once.
 *      Result is cached, so the count fetch and the click expand
 *      share one round-trip.
 *   3. If `count > 0` → render a small "Show N zap comments" pill
 *      in the same style/zone as ZapSplitDisplay. Cards with no
 *      messaged zaps render nothing — keeps the feed clean.
 *   4. Click pill → expand inline. Top 5 by amount visible by
 *      default, "Show N more" reveals the rest in a scrollable
 *      panel attached to the card.
 *
 * Profiles for senders are harvested from the Primal response (the
 * `event_zaps_by_satszapped` op returns kind 0 alongside the zap
 * receipts); we read them out of the shared sender-profile cache, so
 * expand is instant and there's no second batch profile fetch.
 *
 * Lone profile-fetch fallback: when a sender's profile isn't in the
 * Primal response (relay-fallback path, or Primal didn't have it),
 * we fetch via the existing primal.fetchProfiles batch helper.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { fetchZapMessages, getCachedSenderProfile } from '../../../../lib/zapMessages.js'
import { fetchProfiles } from '../../../../lib/primal.js'
import { isSafeUrl, safeNpubEncode } from '../../../../lib/utils.js'

const TOP_N = 5
const MAX_PANEL_HEIGHT_PX = 320

export default function ZapMessagesSection({ noteId }) {
  const [messages, setMessages] = useState(null) // null = not yet fetched, [] = none
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll]   = useState(false)
  const [profilesTick, setProfilesTick] = useState(0)
  const sentinelRef = useRef(null)
  const mountedRef  = useRef(true)
  const fetchedRef  = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // IntersectionObserver — fires fetch once per noteId when the
  // sentinel enters the viewport. `rootMargin` of 200px pre-warms
  // the data slightly before the card is fully visible.
  useEffect(() => {
    if (!noteId || fetchedRef.current) return
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      // Fallback for environments without IO — fetch on mount.
      runFetch()
      return
    }
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          obs.disconnect()
          runFetch()
          break
        }
      }
    }, { rootMargin: '200px 0px' })
    obs.observe(el)
    return () => obs.disconnect()

    async function runFetch() {
      if (fetchedRef.current) return
      fetchedRef.current = true
      try {
        const res = await fetchZapMessages(noteId)
        if (!mountedRef.current) return
        setMessages(res.messages || [])
      } catch {
        if (mountedRef.current) setMessages([])
      }
    }
  }, [noteId])

  // When the user expands, fill in any missing sender profiles via a
  // batch Primal lookup. Profiles already cached (Primal harvest path)
  // render immediately.
  useEffect(() => {
    if (!expanded || !messages || messages.length === 0) return
    const missing = messages
      .map(m => m.senderPubkey)
      .filter(pk => !getCachedSenderProfile(pk))
    if (missing.length === 0) return
    let cancelled = false
    fetchProfiles([...new Set(missing)]).then(() => {
      if (cancelled) return
      // fetchProfiles writes into Primal's profile flow but not our
      // sender cache — bump tick so the rendered names refresh once
      // the user-level profile fetch resolves. The shared profile
      // cache fills via primal.js's parseProfile path, which our
      // PfpName below reads through.
      setProfilesTick(t => t + 1)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [expanded, messages])

  // Pre-mount + pre-fetch state: render the sentinel only. Zero visual
  // weight on the card.
  if (messages === null) {
    return <div ref={sentinelRef} aria-hidden className="h-px" />
  }

  // Fetched but empty — render nothing. Most notes will land here.
  if (messages.length === 0) return null

  const total   = messages.length
  const visible = showAll ? messages : messages.slice(0, TOP_N)
  const more    = Math.max(0, total - TOP_N)

  // Single toggle — same affordance whether collapsed or open. Hides
  // the prior split between a "show" pill and a separate ▴ collapse
  // button on the opposite side of the panel, which felt asymmetric.
  const headerLabel = expanded
    ? `Hide ${total} zap comment${total === 1 ? '' : 's'}`
    : `Show ${total} zap comment${total === 1 ? '' : 's'}`
  const toggleHeader = (
    <button
      type="button"
      onClick={() => {
        setExpanded(e => !e)
        if (expanded) setShowAll(false)
      }}
      aria-expanded={expanded}
      className="inline-flex items-center gap-1.5 text-[10px] font-medium text-yellow-500/90 hover:text-yellow-300 transition-colors"
    >
      <span aria-hidden>⚡</span>
      <span>{headerLabel}</span>
    </button>
  )

  if (!expanded) {
    return <div className="mt-2">{toggleHeader}</div>
  }

  return (
    <div className="border border-neutral-800 rounded p-2 mt-2">
      <div className="mb-1.5">
        {toggleHeader}
      </div>
      <ul
        className={`space-y-1.5 ${showAll && total > TOP_N ? 'overflow-y-auto pr-1' : ''}`}
        style={showAll && total > TOP_N ? { maxHeight: MAX_PANEL_HEIGHT_PX } : undefined}
      >
        {visible.map(m => (
          <ZapMessageRow
            key={m.receiptId}
            msg={m}
            profilesTick={profilesTick}
          />
        ))}
      </ul>
      {!showAll && more > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 w-full text-center text-[10px] text-neutral-500 hover:text-neutral-300"
        >
          Show {more} more
        </button>
      )}
    </div>
  )
}

function ZapMessageRow({ msg /* eslint-disable-line no-unused-vars */, profilesTick }) {
  // profilesTick is in the prop signature so React re-renders when
  // upstream profile data lands. Don't read it inside; just having it
  // change is enough to re-evaluate getCachedSenderProfile below.
  void profilesTick
  const profile = getCachedSenderProfile(msg.senderPubkey)
  const npub    = useMemo(
    () => safeNpubEncode(nip19, msg.senderPubkey, 'ZapMessageRow'),
    [msg.senderPubkey],
  )
  const displayName = profile?.display_name || profile?.name
    || (npub ? npub.slice(0, 12) + '…' : msg.senderPubkey.slice(0, 8))
  const pic = profile?.picture
  // Single inline row: pfp · name · ⚡ amount · comment, all flowing
  // on one line and wrapping naturally when the message is long.
  // Reads more compactly than the previous two-line stack while still
  // keeping the pfp anchored to the left as a clear sender marker.
  return (
    <li className="flex items-start gap-2">
      {pic && isSafeUrl(pic) ? (
        <img
          src={pic}
          alt=""
          className="w-5 h-5 rounded-full object-cover shrink-0 mt-0.5"
          onError={e => { e.currentTarget.style.display = 'none' }}
        />
      ) : (
        <div className="w-5 h-5 rounded-full bg-neutral-700 flex items-center justify-center text-[9px] text-neutral-400 shrink-0 mt-0.5">
          ?
        </div>
      )}
      <div className="min-w-0 flex-1 text-[11px] leading-snug break-words">
        <span className="text-neutral-300">{displayName}</span>
        <span className="text-yellow-400 font-medium ml-1.5">
          ⚡ {formatSats(msg.amountSats)}:
        </span>
        <span className="text-yellow-400 font-medium ml-1.5">{msg.message}</span>
      </div>
    </li>
  )
}

function formatSats(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000)    return `${Math.round(n / 1000)}k`
  if (n >= 1000)      return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}
