import { useState, useEffect, useMemo } from 'react'
import { nip19 } from 'nostr-tools'
import { getNDK } from '../../../lib/ndk.js'
import { fetchProfiles } from '../../../lib/primal.js'
import { isSafeUrl } from '../../../lib/utils.js'
import { parseNoteContent } from '../../../lib/noteParser.js'
import LinkPreview from './LinkPreview.jsx'

// Shared caches with LRU eviction
const CACHE_MAX = 500
function cacheSet(cache, key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, value)
}
const profileCache = new Map()
const eventCache = new Map()

// ─── Profile Mention Chip ────────────────────────────────────────────────────

export function MentionChip({ nip19Str }) {
  const [profile, setProfile] = useState(null)
  const [pubkey, setPubkey] = useState(null)

  useEffect(() => {
    let pk = null
    try {
      const decoded = nip19.decode(nip19Str)
      pk = decoded.type === 'npub' ? decoded.data : decoded.data?.pubkey
    } catch { return }
    if (!pk) return

    setPubkey(pk)

    if (profileCache.has(pk)) {
      setProfile(profileCache.get(pk))
      return
    }

    fetchProfiles([pk]).then(profiles => {
      const p = profiles.get(pk)
      if (p) {
        cacheSet(profileCache, pk, p)
        setProfile(p)
      }
    })
  }, [nip19Str])

  const name = profile?.display_name || profile?.name || (pubkey ? nip19.npubEncode(pubkey).slice(0, 16) + '...' : nip19Str)
  const pic = profile?.picture

  return (
    <span className="text-purple-400 font-medium">@{name}</span>
  )
}

// ─── Embedded body segment renderers ─────────────────────────────────────────
// Used inside EmbeddedNoteCard so the quoted/replied note renders images and
// links like the top-level note, not as plain URL text. We don't reuse
// NotePreview here to avoid a circular import (NotePreview ↔ EntityCard) and
// to keep embedded cards compact — no nested EmbeddedNoteCards, no lightbox.

function EmbedImage({ url }) {
  const [failed, setFailed] = useState(false)
  if (!isSafeUrl(url) || failed) {
    return (
      <a
        href={isSafeUrl(url) ? url : '#'}
        target="_blank"
        rel="noopener noreferrer"
        className="text-purple-400 hover:text-purple-300 underline break-all"
        onClick={e => e.stopPropagation()}
      >
        {url}
      </a>
    )
  }
  return (
    <img
      src={url}
      alt=""
      className="block w-full h-auto rounded my-1.5"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

function EmbedVideo({ url }) {
  if (!isSafeUrl(url)) return <span className="text-neutral-500 break-all">{url}</span>
  return (
    <video
      src={url}
      controls
      className="block w-full h-auto rounded my-1.5"
      preload="metadata"
    />
  )
}

function EmbedYouTube({ videoId }) {
  return (
    <div className="my-1.5 aspect-video">
      <iframe
        src={`https://www.youtube.com/embed/${videoId}`}
        title="YouTube video"
        className="w-full h-full rounded"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  )
}

function renderEmbedSegment(seg, i) {
  switch (seg.type) {
    case 'image':
      return <EmbedImage key={i} url={seg.data?.url || seg.value} />
    case 'video':
      return <EmbedVideo key={i} url={seg.data?.url || seg.value} />
    case 'youtube':
      return <EmbedYouTube key={i} videoId={seg.data?.videoId} />
    case 'link':
      return <LinkPreview key={i} url={seg.data?.url || seg.value} />
    case 'hashtag':
      return <span key={i} className="text-purple-400 font-medium">{seg.value}</span>
    case 'mention':
      return <MentionChip key={i} nip19Str={seg.value.replace('nostr:', '')} />
    case 'note_embed':
      // Don't recurse into another EmbeddedNoteCard — just show the ref as a
      // muted chip so the reader knows there's more nesting without blowing
      // out the card's height.
      return <span key={i} className="text-purple-400 break-all">{seg.value}</span>
    case 'text':
    default:
      return <span key={i} className="whitespace-pre-wrap break-words">{seg.value}</span>
  }
}

// ─── Embedded Note Card ──────────────────────────────────────────────────────

export function EmbeddedNoteCard({ nip19Str }) {
  const [note, setNote] = useState(null)
  const [authorProfile, setAuthorProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cacheKey = null
    let filter = null
    let isAddressable = false

    try {
      const decoded = nip19.decode(nip19Str)
      if (decoded.type === 'note') {
        cacheKey = decoded.data
        filter = { ids: [decoded.data] }
      } else if (decoded.type === 'nevent') {
        cacheKey = decoded.data.id
        filter = { ids: [decoded.data.id] }
      } else if (decoded.type === 'naddr') {
        isAddressable = true
        const { kind, pubkey, identifier } = decoded.data
        cacheKey = `${kind}:${pubkey}:${identifier || ''}`
        filter = { kinds: [kind], authors: [pubkey], '#d': [identifier || ''] }
      }
    } catch {
      setLoading(false)
      return
    }

    if (!filter) { setLoading(false); return }

    // Check cache
    if (eventCache.has(cacheKey)) {
      const cached = eventCache.get(cacheKey)
      setNote(cached)
      resolveAuthor(cached.pubkey)
      setLoading(false)
      return
    }

    // Fetch via NDK
    const ndk = getNDK()

    ndk.fetchEvent(filter).then(event => {
      if (event) {
        let data
        if (isAddressable) {
          // For longform + other parameterized replaceables, pull title and
          // summary out of tags so the preview reads like an article card
          // instead of raw markdown.
          const title   = event.tags?.find(t => t[0] === 'title')?.[1]   || ''
          const summary = event.tags?.find(t => t[0] === 'summary')?.[1] || ''
          const body = title
            ? (summary ? `${title}\n\n${summary}` : title)
            : (event.content || '')
          data = { content: body, created_at: event.created_at, pubkey: event.pubkey }
        } else {
          data = { content: event.content, created_at: event.created_at, pubkey: event.pubkey }
        }
        cacheSet(eventCache, cacheKey, data)
        setNote(data)
        resolveAuthor(event.pubkey)
      }
      setLoading(false)
    }).catch(() => setLoading(false))

    function resolveAuthor(pk) {
      if (profileCache.has(pk)) {
        setAuthorProfile(profileCache.get(pk))
        return
      }
      fetchProfiles([pk]).then(profiles => {
        const p = profiles.get(pk)
        if (p) {
          cacheSet(profileCache, pk, p)
          setAuthorProfile(p)
        }
      })
    }
  }, [nip19Str])

  if (loading) {
    return (
      <div className="border border-neutral-800 rounded-lg p-3 my-2 animate-pulse">
        <div className="h-3 bg-neutral-800 rounded w-1/3 mb-2" />
        <div className="h-2 bg-neutral-800 rounded w-full" />
      </div>
    )
  }

  if (!note) {
    return (
      <div className="border border-neutral-800 rounded-lg p-3 my-2 text-sm text-neutral-500">
        Could not load referenced note
      </div>
    )
  }

  const authorName = authorProfile?.display_name || authorProfile?.name ||
    (note.pubkey ? nip19.npubEncode(note.pubkey).slice(0, 16) + '...' : 'Unknown')
  const authorPic = authorProfile?.picture
  const body = note.content || ''
  // Truncate very long bodies so the card doesn't dominate the surrounding
  // preview, but keep enough room for an inline image URL to survive.
  const snippet = body.length > 600 ? body.slice(0, 600) + '…' : body
  const segments = parseNoteContent(snippet)
  const time = note.created_at ? new Date(note.created_at * 1000).toLocaleDateString() : ''

  return (
    <div className="border border-neutral-800 rounded-lg p-3 my-2 bg-neutral-900/50 font-sans">
      <div className="flex items-center gap-2 mb-2">
        {authorPic && isSafeUrl(authorPic) ? (
          <img src={authorPic} alt="" className="w-5 h-5 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
        ) : (
          <div className="w-5 h-5 rounded-full bg-neutral-700" />
        )}
        <span className="text-sm font-medium text-neutral-300">{authorName}</span>
        {time && <span className="text-xs text-neutral-600">{time}</span>}
      </div>
      <div className="text-sm text-neutral-400 leading-relaxed">
        {segments.map(renderEmbedSegment)}
      </div>
    </div>
  )
}
