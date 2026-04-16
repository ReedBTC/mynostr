import { useState, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import { getNDK } from '../../../lib/ndk.js'
import { fetchProfiles } from '../../../lib/primal.js'
import { isSafeUrl } from '../../../lib/utils.js'

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

// ─── Embedded Note Card ──────────────────────────────────────────────────────

export function EmbeddedNoteCard({ nip19Str }) {
  const [note, setNote] = useState(null)
  const [authorProfile, setAuthorProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let eventId = null
    let relayHint = null

    try {
      const decoded = nip19.decode(nip19Str)
      if (decoded.type === 'note') {
        eventId = decoded.data
      } else if (decoded.type === 'nevent') {
        eventId = decoded.data.id
        relayHint = decoded.data.relays?.[0]
      } else if (decoded.type === 'naddr') {
        // For naddr, we'd need to fetch by kind + pubkey + d-tag
        // Simplified: show as a reference card
        setNote({ content: `Referenced event: ${nip19Str}`, created_at: null, pubkey: decoded.data.pubkey })
        setLoading(false)
        return
      }
    } catch {
      setLoading(false)
      return
    }

    if (!eventId) { setLoading(false); return }

    // Check cache
    if (eventCache.has(eventId)) {
      const cached = eventCache.get(eventId)
      setNote(cached)
      resolveAuthor(cached.pubkey)
      setLoading(false)
      return
    }

    // Fetch via NDK
    const ndk = getNDK()
    const filter = { ids: [eventId] }

    ndk.fetchEvent(filter).then(event => {
      if (event) {
        const data = { content: event.content, created_at: event.created_at, pubkey: event.pubkey }
        cacheSet(eventCache, eventId, data)
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
  const snippet = note.content?.length > 280 ? note.content.slice(0, 280) + '...' : note.content
  const time = note.created_at ? new Date(note.created_at * 1000).toLocaleDateString() : ''

  return (
    <div className="border border-neutral-800 rounded-lg p-3 my-2 bg-neutral-900/50">
      <div className="flex items-center gap-2 mb-2">
        {authorPic && isSafeUrl(authorPic) ? (
          <img src={authorPic} alt="" className="w-5 h-5 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
        ) : (
          <div className="w-5 h-5 rounded-full bg-neutral-700" />
        )}
        <span className="text-sm font-medium text-neutral-300">{authorName}</span>
        {time && <span className="text-xs text-neutral-600">{time}</span>}
      </div>
      <p className="text-sm text-neutral-400 whitespace-pre-wrap break-words">{snippet}</p>
    </div>
  )
}
