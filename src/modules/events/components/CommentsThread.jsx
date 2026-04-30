/**
 * CommentsThread — kind 1111 (NIP-22) comments on a calendar event.
 *
 * NIP-22 uses uppercase tags to identify the ROOT being commented on
 * and lowercase tags for the immediate parent reply. For top-level
 * comments on a calendar event, the two coincide:
 *   A = "<kind>:<author_pubkey>:<dTag>"  (event coordinate)
 *   K = "31922" or "31923"
 *   P = author pubkey
 *   E = optional — pin to a specific revision id
 *   a/k/p mirror A/K/P for top-level comments.
 *
 * Phase 1 ships flat replies (top-level only) — Phase 2 can add
 * nested threading by reading lowercase `e` tags and grouping.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { useNavigate } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { getNDK, connectAndWait, signWithTimeout, publishToPool } from '../../../lib/ndk.js'
import { useLoginModal } from '../../../components/LoginModalContext.jsx'
import { fetchProfiles } from '../../../lib/primal.js'
import { isSafeUrl, safeNpubEncode } from '../../../lib/utils.js'
import { coordOf } from '../../../lib/eventTypes.js'

// We WRITE kind 1111 (NIP-22, the modern spec for non-kind-1 comments)
// but READ both kinds: many existing event clients (Plektos, others)
// post replies as plain kind-1 notes with `a`/`e` tags. Reading both
// makes the thread reflect what people are actually saying everywhere.
const KIND_COMMENT_NIP22  = 1111
const KIND_COMMENT_LEGACY = 1
const COMMENT_KINDS = [KIND_COMMENT_LEGACY, KIND_COMMENT_NIP22]

const MAX_COMMENT_LENGTH = 2000

// Render-side cap. Anything longer is clipped behind a "Show more"
// toggle so a 500KB comment can't render 500KB of DOM. Higher than the
// compose cap (2000) to accommodate longer comments from other clients.
const RENDER_TRUNCATE_AT = 5000

export default function CommentsThread({ parsed, sessionUser }) {
  const navigate = useNavigate()
  const { openLogin } = useLoginModal()
  const eventCoord = coordOf(parsed)

  const [comments, setComments] = useState([])  // [{ id, pubkey, content, createdAt }]
  const [loading, setLoading] = useState(true)
  const [profileMap, setProfileMap] = useState(() => new Map())

  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState('')

  // Fetch comments on mount + whenever the event coord changes.
  // Two queries fire in parallel:
  //   • #A (NIP-22 uppercase) for spec-compliant comments
  //   • #a (lowercase) for kind-1 legacy replies AND for relays that
  //     don't index uppercase letter tags
  // Results merged and deduped by id.
  useEffect(() => {
    if (!eventCoord) { setComments([]); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setComments([])
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        const [setUpper, setLower] = await Promise.all([
          ndk.fetchEvents({ kinds: COMMENT_KINDS, '#A': [eventCoord], limit: 200 }).catch(() => null),
          ndk.fetchEvents({ kinds: COMMENT_KINDS, '#a': [eventCoord], limit: 200 }).catch(() => null),
        ])
        if (cancelled) return
        const byId = new Map()
        for (const set of [setUpper, setLower]) {
          if (!set) continue
          for (const ev of set) {
            if (!ev?.id || !ev?.pubkey) continue
            if (typeof ev.content !== 'string') continue
            // Skip our own kind-1 notes that mention the event in
            // passing — only treat kind-1 as a reply when at least one
            // a/A tag points to this event coord. (NIP-22 already
            // forces the right tags; legacy kind-1 might be a quote.)
            if (ev.kind === KIND_COMMENT_LEGACY) {
              const refsThisEvent = (ev.tags || []).some(t =>
                (t[0] === 'a' || t[0] === 'A') && t[1] === eventCoord
              )
              if (!refsThisEvent) continue
            }
            byId.set(ev.id, {
              id: ev.id,
              pubkey: ev.pubkey,
              kind: ev.kind,
              content: ev.content,
              createdAt: ev.created_at || 0,
            })
          }
        }
        const list = [...byId.values()]
        // Newest-first so the most recent reaction is what new readers
        // see at a glance. Older comments scroll below.
        list.sort((a, b) => b.createdAt - a.createdAt)
        setComments(list)
      } catch {
        if (!cancelled) setComments([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [eventCoord])

  // Bulk-fetch author profiles for the comments we just landed.
  const pubkeysKey = useMemo(() => {
    const set = new Set()
    for (const c of comments) set.add(c.pubkey)
    return [...set].sort().join('|')
  }, [comments])

  useEffect(() => {
    if (!pubkeysKey) return
    const pubkeys = pubkeysKey.split('|').filter(Boolean)
    if (pubkeys.length === 0) return
    let cancelled = false
    fetchProfiles(pubkeys).then(fetched => {
      if (cancelled) return
      setProfileMap(prev => {
        const next = new Map(prev)
        for (const [k, v] of fetched) next.set(k, v)
        return next
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [pubkeysKey])

  const handlePost = useCallback(async () => {
    if (posting) return
    if (!sessionUser?.pubkey) { openLogin(); return }
    const text = draft.trim()
    if (!text) return
    if (text.length > MAX_COMMENT_LENGTH) {
      setPostError(`Comment too long (${MAX_COMMENT_LENGTH} max).`)
      return
    }
    setPosting(true)
    setPostError('')
    try {
      const ndk = getNDK()
      const ev = new NDKEvent(ndk)
      ev.kind = KIND_COMMENT_NIP22
      ev.content = text
      ev.created_at = Math.floor(Date.now() / 1000)
      ev.tags = [
        // Root coordinates — for a kind 31922/31923 event, the
        // addressable form is the canonical reference.
        ['A', eventCoord],
        ['K', String(parsed.kind)],
        ['P', parsed.pubkey],
        // Lowercase mirror — top-level comment, parent === root.
        ['a', eventCoord],
        ['k', String(parsed.kind)],
        ['p', parsed.pubkey],
      ]
      // Optional E/e tag — pinning to a specific revision lets clients
      // surface "comment was on the version you saw" UI later. Cheap
      // to include.
      if (parsed.id) {
        ev.tags.push(['E', parsed.id])
        ev.tags.push(['e', parsed.id])
      }
      ev.tags.push(['client', 'mynostr'])
      await signWithTimeout(ev)
      await publishToPool(ev)

      // Optimistic prepend so the user sees their post immediately.
      setComments(prev => [
        {
          id: ev.id,
          pubkey: ev.pubkey,
          kind: KIND_COMMENT_NIP22,
          content: text,
          createdAt: ev.created_at,
        },
        ...prev,
      ])
      setDraft('')
    } catch (e) {
      setPostError(e?.message || 'Post failed.')
    } finally {
      setPosting(false)
    }
  }, [posting, draft, eventCoord, parsed, sessionUser, openLogin])

  function handleAuthorClick(pubkey) {
    const npub = safeNpubEncode(nip19, pubkey, 'CommentsThread.author')
    if (npub) navigate(`/${npub}/profile`)
  }

  if (!eventCoord) return null

  return (
    <div className="mt-6 pt-4 border-t border-neutral-800">
      <h2 className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-3">
        Comments {comments.length > 0 && <span className="text-neutral-600">({comments.length})</span>}
      </h2>

      {/* Compose row — always visible. Login-gated; tapping post when
          logged out opens the login modal. */}
      <div className="space-y-1.5 mb-4">
        <textarea
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (postError) setPostError('') }}
          placeholder={sessionUser ? 'Add a comment…' : 'Sign in to comment'}
          rows={3}
          maxLength={MAX_COMMENT_LENGTH}
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-purple-600 resize-y"
        />
        <div className="flex items-center justify-between gap-2">
          {postError ? (
            <span className="text-xs text-rose-400">{postError}</span>
          ) : (
            <span className="text-[10px] text-neutral-600">
              {draft.length > 0 && `${draft.length} / ${MAX_COMMENT_LENGTH}`}
            </span>
          )}
          <button
            type="button"
            onClick={handlePost}
            disabled={posting || !draft.trim()}
            className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-40 transition-colors inline-flex items-center gap-1.5"
          >
            {posting ? (
              <>
                <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                Posting…
              </>
            ) : 'Post'}
          </button>
        </div>
      </div>

      {/* Thread */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-neutral-900 animate-pulse" />
          ))}
        </div>
      ) : comments.length === 0 ? (
        <p className="text-xs text-neutral-500 text-center py-6">
          No comments yet. Start the discussion.
        </p>
      ) : (
        <ul className="space-y-3">
          {comments.map(c => (
            <CommentRow
              key={c.id}
              comment={c}
              profile={profileMap.get(c.pubkey)}
              onAuthorClick={() => handleAuthorClick(c.pubkey)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function CommentRow({ comment, profile, onAuthorClick }) {
  const display = profile?.display_name || profile?.displayName || profile?.name || ''
  const fallback = (display || comment.pubkey || '?').slice(0, 1).toUpperCase()
  const pic = profile?.picture && isSafeUrl(profile.picture) ? profile.picture : ''
  const np = safeNpubEncode(nip19, comment.pubkey, 'CommentRow')
  const npubShort = np ? np.slice(0, 14) + '…' : ''

  // Render-side truncation. Most comments come in well under the cap;
  // this exists to defang spam/garbage comments from blowing up the DOM.
  const [expanded, setExpanded] = useState(false)
  const overlong = comment.content.length > RENDER_TRUNCATE_AT
  const display_content = (overlong && !expanded)
    ? comment.content.slice(0, RENDER_TRUNCATE_AT)
    : comment.content

  return (
    <li className="flex items-start gap-2.5">
      <button
        type="button"
        onClick={onAuthorClick}
        className="flex-shrink-0 w-7 h-7 rounded-full bg-neutral-800 border border-neutral-700 overflow-hidden flex items-center justify-center text-xs text-neutral-300 hover:ring-1 hover:ring-purple-500 transition-all"
        title={display || npubShort}
        aria-label={`View ${display || 'author'}'s profile`}
      >
        {pic ? (
          <img
            src={pic}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.replaceWith(document.createTextNode(fallback)) }}
          />
        ) : fallback}
      </button>
      <div className="flex-1 min-w-0 bg-neutral-900/40 border border-neutral-900 rounded-md px-3 py-2">
        <div className="flex items-baseline gap-2 mb-0.5">
          <button
            type="button"
            onClick={onAuthorClick}
            className="text-xs font-medium text-neutral-200 hover:text-purple-200 truncate transition-colors"
          >
            {display || npubShort || 'unknown'}
          </button>
          <span className="text-[10px] text-neutral-600 flex-shrink-0">
            {formatRelativeTime(comment.createdAt)}
          </span>
        </div>
        <p className="text-xs text-neutral-200 whitespace-pre-wrap break-words leading-relaxed">
          {renderCommentBody(display_content)}
          {overlong && !expanded && '…'}
        </p>
        {overlong && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="mt-1 text-[10px] text-neutral-500 hover:text-neutral-200 transition-colors"
          >
            {expanded ? 'Show less' : `Show full comment (${comment.content.length.toLocaleString()} chars)`}
          </button>
        )}
      </div>
    </li>
  )
}

// Linkify URLs in comment bodies. Splits on URL pattern, wraps matches
// in safe anchor tags. Plain text segments stay as React text nodes
// (no XSS surface — text inside JSX is escaped). The regex is
// deliberately conservative: http(s):// only, no schemeless URLs, no
// markdown link parsing. Covers ~99% of what users paste while
// avoiding false positives on stray colons / dots.
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/gi
function renderCommentBody(text) {
  if (!text) return null
  const parts = text.split(URL_REGEX)
  return parts.map((part, i) => {
    if (i % 2 === 1 && isSafeUrl(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="text-purple-300 hover:text-purple-200 underline-offset-2 hover:underline break-all"
        >
          {part}
        </a>
      )
    }
    return part
  })
}

function formatRelativeTime(unixSec) {
  if (!unixSec) return ''
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
