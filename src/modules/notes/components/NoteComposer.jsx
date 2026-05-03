/**
 * NoteComposer — the Write pane for the Notes module.
 * Kind 1 short note composer with live preview below.
 * Phone-width layout even on desktop — notes are mobile content.
 *
 * Extracted from NotesModule.jsx so the module can host sibling tabs
 * (My Notes, My Bookmarks, Search). The composer itself owns all the
 * write-flow state (content, zap splits, manual tags, etc.).
 */
import { useState, useCallback, useMemo, useRef, useLayoutEffect, useEffect } from 'react'
import { NDKRelaySet } from '@nostr-dev-kit/ndk'
import ZapSplitsSection from './NoteEditor.jsx'
import NotePreview from './NotePreview.jsx'
import MentionAutocomplete from './MentionAutocomplete.jsx'
import EditorMirror from './EditorMirror.jsx'
import { EmbeddedNoteCard } from './EntityCard.jsx'
import RelayOverrideSection from './RelayOverrideSection.jsx'
import { nip19 } from 'nostr-tools'
import { extractTags, mergeTags, validateKind1Event } from '../../../lib/noteParser.js'
import { buildDraftSnapshotFromEvent } from '../../../lib/draftFromEvent.js'
import { getNDK } from '../../../lib/ndk.js'
import { uploadToBlossom } from '../../../lib/blossom.js'
import { useImageUploadFlow } from '../../../components/ImageUploadConfirm.jsx'
import { useIsMobile } from '../../../hooks/useIsMobile.js'
import { parseReplyRefs } from '../../../lib/nip10.js'
import {
  scheduleNote,
  isSchedulerConfigured,
  MIN_LEAD_SECONDS,
  MAX_FUTURE_SECONDS,
} from '../../../lib/scheduler.js'
import TimePicker from '../../events/components/TimePicker.jsx'

// Default height — roughly a full phone-screen's worth of composing room
const TEXTAREA_MIN_H = 200

/** Render an HH:MM 24-hour string as 12-hour AM/PM. Inline rather than
 *  pulled from TimePicker (which doesn't export it) — used only by
 *  the locked schedule-time display in viewingScheduled mode. */
function format12h(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return hhmm || ''
  const h = +m[1]
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m[2]} ${ampm}`
}

/**
 * Draft-driven composer. Parent owns the draft list (useNoteDrafts hook);
 * this component mounts with `draft.snapshot` as initial state, then emits
 * updated {snapshot, publishable} upward via onSnapshotChange on every edit.
 * Keyed remount (`key={draft.id}` in parent) handles clean state transitions
 * between drafts — no need to derive state from props after mount.
 */
export default function NoteComposer({
  user,
  draft,
  onSnapshotChange,
  onPublish,
  onClear,
  onAckPublished,
  onOpenDraftsMobile,
  draftCount = 1,
  // When viewingScheduled is true, the composer is in inspect-mode for
  // an already-scheduled note: the editable surface is wrapped in a
  // <fieldset disabled> (locks every input/button beneath it) and the
  // publish/schedule action is replaced with a red "Cancel scheduled
  // note" button. Cancel calls back to the parent which DELETEs from
  // the worker and rebuilds an editable draft seeded with the same
  // content + publishAt — the user falls naturally back into a normal
  // editable composer for that draft.
  viewingScheduled = false,
  onCancelScheduled,
}) {
  const readOnly = !!user?.readOnly
  const isMobile = useIsMobile()
  const fileRef = useRef(null)
  const [idCopied, setIdCopied] = useState(false)

  const initial = draft?.snapshot || {}

  // Core state — seeded once from the draft's snapshot on mount
  const [content, setContent] = useState(initial.content || '')
  const [zapSplits, setZapSplits] = useState(initial.zapSplits || [])
  // undefined = auto (catch remainder); number = explicit user pct.
  // Snapshot persists null for "explicit absent"; convert on hydrate.
  const [userZapPct, setUserZapPct] = useState(
    initial.userZapPct === null || initial.userZapPct === undefined ? undefined : initial.userZapPct
  )
  const [manualTags, setManualTags] = useState(initial.manualTags || [])
  // Mentions: displayName → pubkey. State (not ref) so expandedContent
  // memo recomputes when we add/remove entries.
  const [mentions, setMentions] = useState(
    () => new Map(Object.entries(initial.mentions || {}))
  )
  const [relayOverride, setRelayOverride] = useState(
    initial.relayOverride || { enabled: false, relays: [] }
  )

  // Publish state is owned by the parent hook (per-draft). Derive locally.
  const publishing = draft?.status === 'publishing'
  const publishResult = draft?.status === 'published' ? draft?.publishResult : null
  const publishError = draft?.publishError || null

  // UI state
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showRelayOptions, setShowRelayOptions] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const textareaRef = useRef(null)
  const [uploadError, setUploadError] = useState(null)
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState('')
  const imageInputRef = useRef(null)
  const { requestUpload: requestImageUpload, element: uploadPicker } = useImageUploadFlow()
  const [videoUploading, setVideoUploading] = useState(false)
  const [videoError, setVideoError] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [mentionActive, setMentionActive] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const importInputRef = useRef(null)
  const [clearPending, setClearPending] = useState(false)
  const clearTimerRef = useRef(null)

  // Schedule (kind 1 future-publish via the scheduler worker).
  // Hidden when the worker isn't configured (no VITE_SCHEDULER_URL).
  const schedulerEnabled = isSchedulerConfigured()
  const [scheduleMode, setScheduleMode] = useState(false)
  // Split into separate date + time fields to mirror the Events
  // composer pattern. scheduleDate is "YYYY-MM-DD" (native date input);
  // scheduleTime is "HH:MM" 24-hour (TimePicker's I/O).
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduling, setScheduling]     = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleResult, setScheduleResult] = useState(null) // { eventId, scheduledFor }

  // Reply / quote threading inputs (text the user types), plus the fetched
  // reply target — needed so we can emit a proper NIP-10 p-tag for the author
  // and preserve the thread's root when replying to a mid-thread note.
  const [replyToInput, setReplyToInput] = useState(initial.replyToInput || '')
  const [quoteInput, setQuoteInput] = useState(initial.quoteInput || '')
  const [replyTargetEvent, setReplyTargetEvent] = useState(null)
  const [replyTargetLoading, setReplyTargetLoading] = useState(false)
  const [replyTargetError, setReplyTargetError] = useState('')
  // Tracks timers created outside React effects (image error, copy feedback)
  // so they can be cleared on unmount — avoids "update on unmounted component"
  // warnings if the user switches tabs mid-timeout.
  const pendingTimersRef = useRef(new Set())

  // Auto-cancel the clear-confirm state after 3s if user doesn't follow through
  useEffect(() => {
    if (clearPending) {
      clearTimerRef.current = setTimeout(() => setClearPending(false), 3000)
    }
    return () => clearTimeout(clearTimerRef.current)
  }, [clearPending])

  useEffect(() => {
    return () => {
      for (const id of pendingTimersRef.current) clearTimeout(id)
      pendingTimersRef.current.clear()
    }
  }, [])

  // Resize textarea to fit content whenever it changes (covers programmatic
  // sets like JSON import). Re-runs when returning from preview mode so the
  // remounted textarea picks up its scrollHeight correctly.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.max(ta.scrollHeight, TEXTAREA_MIN_H) + 'px'
  }, [content, previewMode])

  // Shared: load a kind 1 event object into the editor
  const loadEventIntoEditor = useCallback(async (eventObj) => {
    const snap = await buildDraftSnapshotFromEvent(eventObj, user?.pubkey)
    setMentions(new Map(Object.entries(snap.mentions)))
    setContent(snap.content)
    setZapSplits(snap.zapSplits)
    setUserZapPct(snap.userZapPct == null ? undefined : snap.userZapPct)
    setManualTags(snap.manualTags)
    setReplyToInput(snap.replyToInput)
    setQuoteInput(snap.quoteInput)
    if (snap.zapSplits.length > 0 || snap.userZapPct != null) setShowAdvanced(true)
    // Same auto-detect logic as the mount effect, but for the in-place
    // upload path (this composer instance isn't being remounted —
    // we're mutating its state, so the mount effect can't catch it).
    if (snap.publishAt && Number.isFinite(snap.publishAt)
        && snap.publishAt > Math.floor(Date.now() / 1000) + 60) {
      setScheduleMode(true)
      const d = new Date(snap.publishAt * 1000)
      const pad = (n) => String(n).padStart(2, '0')
      setScheduleDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
      setScheduleTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
    }
  }, [user?.pubkey])

  // Load event from JSON file
  const handleFileUpload = useCallback(async (file) => {
    setUploadError(null)

    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      setUploadError('Please upload a .json file')
      return
    }
    if (file.size > 1_000_000) {
      setUploadError('File too large (max 1 MB)')
      return
    }

    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const { valid, errors, event } = validateKind1Event(json)

      if (!valid) {
        setUploadError(errors.join('; '))
        return
      }

      await loadEventIntoEditor(event)
    } catch (e) {
      setUploadError(`Invalid JSON: ${e.message}`)
    }
  }, [loadEventIntoEditor])

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0]
    if (file) handleFileUpload(file)
    e.target.value = ''
  }, [handleFileUpload])

  const handleClear = useCallback(() => {
    setContent('')
    setZapSplits([])
    setUserZapPct(undefined)
    setManualTags([])
    setUploadError(null)
    setShowAdvanced(false)
    setShowRelayOptions(false)
    setPreviewMode(false)
    setImportError('')
    setClearPending(false)
    setReplyToInput('')
    setQuoteInput('')
    setReplyTargetEvent(null)
    setReplyTargetError('')
    setMentions(new Map())
    setRelayOverride({ enabled: false, relays: [] })
    // Parent hook clears the draft's status/publishResult/publishError.
    if (onClear) onClear()
  }, [onClear])

  const handleClearClick = useCallback(() => {
    if (!clearPending) { setClearPending(true); return }
    handleClear()
  }, [clearPending, handleClear])

  // Show the Clear button only when there's something worth clearing
  const hasEditorState = !!(
    content.trim() ||
    zapSplits.length ||
    userZapPct != null ||
    manualTags.length ||
    replyToInput.trim() ||
    quoteInput.trim() ||
    relayOverride.enabled
  )

  // Import note by ID (note1... or nevent1...)
  const handleImportById = useCallback(async (input) => {
    const val = input.trim()
    if (!val) return

    setImportLoading(true)
    setImportError('')

    try {
      let eventId = null
      let relayHints = []
      const bare = val.replace(/^nostr:/, '')
      const decoded = nip19.decode(bare)
      if (decoded.type === 'note') {
        eventId = decoded.data
      } else if (decoded.type === 'nevent') {
        eventId = decoded.data.id
        relayHints = decoded.data.relays || []
      } else {
        throw new Error('Expected a note1 or nevent1 identifier')
      }

      const ndk = getNDK()

      const waitStart = Date.now()
      while (!ndk.pool.connectedRelays().length && Date.now() - waitStart < 3000) {
        await new Promise(r => setTimeout(r, 100))
      }

      // Use a transient relay set combining the default pool with any safe
      // hints from the nevent. This keeps hint relays scoped to the lookup —
      // they don't permanently join the pool (which would broaden the NIP-42
      // AUTH surface to attacker-controlled relays on every future request).
      const safeHints = relayHints.filter(r => typeof r === 'string' && r.startsWith('wss://'))
      const defaultUrls = [...ndk.pool.relays.values()].map(r => r.url)
      const combined = [...new Set([...defaultUrls, ...safeHints])]
      const relaySet = combined.length ? NDKRelaySet.fromRelayUrls(combined, ndk, false) : undefined

      let event = await ndk.fetchEvent({ ids: [eventId] }, undefined, relaySet)
      if (!event) {
        await new Promise(r => setTimeout(r, 2000))
        event = await ndk.fetchEvent({ ids: [eventId] }, undefined, relaySet)
      }
      if (!event) throw new Error('Note not found on connected relays')
      if (event.kind !== 1) throw new Error(`Expected kind 1, got kind ${event.kind}`)

      await loadEventIntoEditor({
        kind: event.kind,
        pubkey: event.pubkey,
        created_at: event.created_at,
        content: event.content,
        tags: event.tags || [],
      })
      if (importInputRef.current) importInputRef.current.value = ''
    } catch (e) {
      setImportError(e.message || 'Failed to import note')
    } finally {
      setImportLoading(false)
    }
  }, [loadEventIntoEditor])

  // Image upload — insert URL at cursor position
  const handleImageUpload = useCallback(async (file) => {
    if (readOnly) return
    if (!file || !file.type.startsWith('image/')) return
    if (imageUploading) return
    const ready = await requestImageUpload(file)
    if (!ready) return
    setImageUploading(true)
    setImageError('')
    try {
      const url = await uploadToBlossom(ready)
      const ta = textareaRef.current
      const insertPos = ta?.selectionStart ?? content.length
      const before = content.slice(0, insertPos)
      const after = content.slice(insertPos)
      // Add spacing around the URL
      const needsBefore = before.length > 0 && !before.endsWith('\n') && !before.endsWith(' ')
      const needsAfter = after.length > 0 && !after.startsWith('\n') && !after.startsWith(' ')
      const newContent = before + (needsBefore ? '\n' : '') + url + (needsAfter ? '\n' : '') + after
      setContent(newContent)
    } catch (err) {
      setImageError(err.message || 'Image upload failed')
      const id = setTimeout(() => {
        pendingTimersRef.current.delete(id)
        setImageError('')
      }, 5000)
      pendingTimersRef.current.add(id)
    } finally {
      setImageUploading(false)
    }
  }, [content, imageUploading, requestImageUpload, readOnly])

  // Video upload — insert URL at cursor position. No compression (long-term
  // feature). Accept list covers iPhone/Android defaults + X.com's top
  // formats; any URL rendered inline by NotePreview requires one of these
  // extensions, so we gate the input to match.
  //
  // MIME validation note: file.type is browser-reported (usually derived from
  // the extension) and can be spoofed by renaming a file. We don't magic-byte
  // sniff — Primal's Blossom server validates on upload, and even a spoofed
  // file served back under a video mime won't execute in a <video> tag. Worst
  // case is a broken embed in the viewer's feed.
  const handleVideoUpload = useCallback(async (file) => {
    if (readOnly) return
    if (!file) return
    if (videoUploading) return
    const okTypes = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
    if (!okTypes.has(file.type)) {
      setVideoError('Unsupported video format. Use MP4, MOV, WebM, or M4V.')
      return
    }
    // 50 MB cap — SubtleCrypto's SHA-256 needs the whole buffer in RAM
    // (no streaming API), and mid-range phones OOM past this point.
    const MAX_BYTES = 50 * 1024 * 1024
    if (file.size > MAX_BYTES) {
      setVideoError('Video too large (max 50 MB)')
      return
    }
    setVideoUploading(true)
    setVideoError('')
    try {
      const url = await uploadToBlossom(file)
      const ta = textareaRef.current
      const insertPos = ta?.selectionStart ?? content.length
      const before = content.slice(0, insertPos)
      const after = content.slice(insertPos)
      const needsBefore = before.length > 0 && !before.endsWith('\n') && !before.endsWith(' ')
      const needsAfter = after.length > 0 && !after.startsWith('\n') && !after.startsWith(' ')
      const newContent = before + (needsBefore ? '\n' : '') + url + (needsAfter ? '\n' : '') + after
      setContent(newContent)
    } catch (err) {
      setVideoError(err.message || 'Video upload failed')
      const id = setTimeout(() => {
        pendingTimersRef.current.delete(id)
        setVideoError('')
      }, 5000)
      pendingTimersRef.current.add(id)
    } finally {
      setVideoUploading(false)
    }
  }, [content, videoUploading, readOnly])

  // Handle @mention selection — insert @DisplayName, track mapping
  const handleMentionSelect = useCallback(({ name, pubkey }, start, end) => {
    // Ensure unique display name in the map
    let displayName = name
    if (mentions.has(displayName) && mentions.get(displayName) !== pubkey) {
      const short = nip19.npubEncode(pubkey).slice(5, 9)
      displayName = `${name}_${short}`
    }
    setMentions(prev => {
      const next = new Map(prev)
      next.set(displayName, pubkey)
      return next
    })

    const token = `@${displayName}`
    const before = content.slice(0, start)
    const after = content.slice(end)
    const needsSpace = after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n')
    const newContent = before + token + (needsSpace ? ' ' : '') + after
    setContent(newContent)
    const newPos = start + token.length + (needsSpace ? 1 : 0)
    setCursorPos(newPos)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        ta.selectionStart = ta.selectionEnd = newPos
      }
    })
  }, [content, mentions])

  // Parse a note1/nevent1/naddr1 string (with or without "nostr:" prefix) to
  // a descriptor used by both the Reply and Quote input fields. For
  // addressable events (naddr, e.g. longform articles) we carry the
  // kind+pubkey+d-tag coordinate so we can emit an NIP-10 a-tag and skip
  // the relay fetch (the author is already in the decoded payload).
  const parseNoteIdInput = useCallback((input) => {
    const val = (input || '').trim()
    if (!val) return { valid: false, empty: true }
    try {
      const bare = val.replace(/^nostr:/, '')
      const decoded = nip19.decode(bare)
      if (decoded.type === 'note') {
        return {
          valid: true,
          addressable: false,
          id: decoded.data.toLowerCase(),
          relays: [],
          bech32: nip19.neventEncode({ id: decoded.data }),
        }
      }
      if (decoded.type === 'nevent') {
        const relays = decoded.data.relays || []
        return {
          valid: true,
          addressable: false,
          id: decoded.data.id.toLowerCase(),
          relays,
          bech32: nip19.neventEncode({
            id: decoded.data.id,
            relays: relays.slice(0, 3),
            author: decoded.data.author,
          }),
        }
      }
      if (decoded.type === 'naddr') {
        const { kind, pubkey, identifier, relays = [] } = decoded.data
        return {
          valid: true,
          addressable: true,
          eventKind: kind,
          pubkey: (pubkey || '').toLowerCase(),
          dTag: identifier || '',
          aCoord: `${kind}:${pubkey}:${identifier || ''}`,
          relays,
          bech32: nip19.naddrEncode({
            kind,
            pubkey,
            identifier: identifier || '',
            relays: relays.slice(0, 3),
          }),
        }
      }
      // Decoded, but not as a note/event/article — almost always an npub or
      // nprofile pasted by mistake. Be specific so the user knows why.
      return {
        valid: false,
        error: 'This field needs a note ID (note1…, nevent1…, or naddr1…), not a profile or key.',
      }
    } catch {
      return {
        valid: false,
        error: 'Paste a note ID to reply or quote — e.g. note1…, nevent1…, or naddr1…',
      }
    }
  }, [])

  const replyToRef = useMemo(() => parseNoteIdInput(replyToInput), [replyToInput, parseNoteIdInput])
  const quoteRef   = useMemo(() => parseNoteIdInput(quoteInput),   [quoteInput,   parseNoteIdInput])

  // Fetch the reply target so we know the author (for the p-tag) and
  // whether it's itself a reply (so we can preserve the original thread root
  // instead of pretending the target is the root). For addressable targets
  // (naddr — e.g. longform articles) the author and kind are already in
  // the decode, so we skip the network round-trip and synthesize the target.
  useEffect(() => {
    if (!replyToRef.valid) {
      setReplyTargetEvent(null)
      setReplyTargetError('')
      setReplyTargetLoading(false)
      return
    }

    // Addressable reply target — no fetch needed.
    if (replyToRef.addressable) {
      setReplyTargetEvent({
        addressable: true,
        aCoord: replyToRef.aCoord,
        eventKind: replyToRef.eventKind,
        pubkey: replyToRef.pubkey,
        dTag: replyToRef.dTag,
        tags: [],
      })
      setReplyTargetError('')
      setReplyTargetLoading(false)
      return
    }

    if (replyTargetEvent && !replyTargetEvent.addressable && replyTargetEvent.id === replyToRef.id) return

    let cancelled = false
    setReplyTargetLoading(true)
    setReplyTargetError('')

    ;(async () => {
      try {
        const ndk = getNDK()
        const waitStart = Date.now()
        while (!ndk.pool.connectedRelays().length && Date.now() - waitStart < 3000) {
          await new Promise(r => setTimeout(r, 100))
        }
        const safeHints = (replyToRef.relays || []).filter(r => typeof r === 'string' && r.startsWith('wss://'))
        const defaultUrls = [...ndk.pool.relays.values()].map(r => r.url)
        const combined = [...new Set([...defaultUrls, ...safeHints])]
        const relaySet = combined.length ? NDKRelaySet.fromRelayUrls(combined, ndk, false) : undefined

        let event = await ndk.fetchEvent({ ids: [replyToRef.id] }, undefined, relaySet)
        if (!event && !cancelled) {
          await new Promise(r => setTimeout(r, 1500))
          event = await ndk.fetchEvent({ ids: [replyToRef.id] }, undefined, relaySet)
        }
        if (cancelled) return
        if (!event) throw new Error('Reply target not found on connected relays')
        if (event.kind !== 1) throw new Error(`Expected kind 1, got kind ${event.kind}`)

        setReplyTargetEvent({
          addressable: false,
          id: event.id.toLowerCase(),
          pubkey: event.pubkey,
          tags: event.tags || [],
        })
        setReplyTargetLoading(false)
      } catch (e) {
        if (cancelled) return
        setReplyTargetError(e.message || 'Failed to load reply target')
        setReplyTargetEvent(null)
        setReplyTargetLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [replyToRef.valid, replyToRef.id, replyToRef.addressable, replyToRef.aCoord])

  // Expand @DisplayName tokens back to nostr:npub1... for publish/preview/export.
  // Also appends the quoted nevent (if set) so the quote renders as an embed
  // card in any client — and so extractTags() picks it up as an e-tag.
  const expandedContent = useMemo(() => {
    let text = content
    for (const [name, pubkey] of mentions) {
      const npub = nip19.npubEncode(pubkey)
      text = text.replaceAll(`@${name}`, `nostr:${npub}`)
    }
    if (quoteRef.valid && quoteRef.bech32) {
      // Don't double-embed if the user already referenced the same target in
      // their content. For events (note1/nevent1) we match by hex id; for
      // addressable events (naddr1) we match by kind:pubkey:d coordinate.
      const existingIds = new Set()
      const existingCoords = new Set()
      for (const m of text.matchAll(/nostr:(note1[a-z0-9]+|nevent1[a-z0-9]+|naddr1[a-z0-9]+)/g)) {
        try {
          const d = nip19.decode(m[1])
          if (d.type === 'note') existingIds.add(d.data.toLowerCase())
          else if (d.type === 'nevent') existingIds.add(d.data.id.toLowerCase())
          else if (d.type === 'naddr') existingCoords.add(`${d.data.kind}:${d.data.pubkey}:${d.data.identifier || ''}`)
        } catch {}
      }
      const already = quoteRef.addressable
        ? existingCoords.has(quoteRef.aCoord)
        : existingIds.has(quoteRef.id)
      if (!already) {
        const uri = `nostr:${quoteRef.bech32}`
        text = text.trim() ? `${text}\n\n${uri}` : uri
      }
    }
    return text
  }, [content, quoteRef, mentions])

  // NIP-10 reply tags. If the target is itself a reply, carry its root forward
  // so we don't flatten mid-thread replies into fake top-level replies. Also
  // propagate p-tags from the target (the reply chain participants).
  //
  // For addressable targets (naddr — e.g. a longform article) we emit an
  // a-tag root instead of an e-tag, since the article is identified by its
  // kind:pubkey:d coordinate, not a single event id.
  const replyTags = useMemo(() => {
    if (!replyToRef.valid) return []
    const tags = []
    const hint = replyToRef.relays?.[0] || ''

    if (replyToRef.addressable) {
      tags.push(['a', replyToRef.aCoord, hint, 'root'])
      if (replyToRef.pubkey) tags.push(['p', replyToRef.pubkey])
      return tags
    }

    const targetId = replyToRef.id
    if (replyTargetEvent && !replyTargetEvent.addressable && replyTargetEvent.id === targetId) {
      const refs = parseReplyRefs({ tags: replyTargetEvent.tags })
      if (refs.rootId && refs.rootId !== targetId) {
        tags.push(['e', refs.rootId, '', 'root'])
        tags.push(['e', targetId, hint, 'reply'])
      } else {
        tags.push(['e', targetId, hint, 'root'])
      }
      const seenP = new Set()
      if (replyTargetEvent.pubkey) {
        seenP.add(replyTargetEvent.pubkey.toLowerCase())
        tags.push(['p', replyTargetEvent.pubkey])
      }
      for (const t of replyTargetEvent.tags) {
        if (t[0] !== 'p' || typeof t[1] !== 'string') continue
        const pk = t[1].toLowerCase()
        if (seenP.has(pk)) continue
        seenP.add(pk)
        tags.push(['p', t[1]])
      }
    } else {
      // Fetch hasn't completed (or failed) — emit a best-effort e-tag so the
      // reply still threads, even without the author's p-tag.
      tags.push(['e', targetId, hint, 'root'])
    }
    return tags
  }, [replyToRef, replyTargetEvent])

  const finalTags = useMemo(() => {
    const autoTags = extractTags(expandedContent)

    // If we have reply tags, strip any auto-extracted e/p/a tags that collide
    // with them — the marked reply tags are authoritative.
    let filteredAuto = autoTags
    if (replyTags.length) {
      const eIds    = new Set(replyTags.filter(t => t[0] === 'e').map(t => t[1].toLowerCase()))
      const pIds    = new Set(replyTags.filter(t => t[0] === 'p').map(t => t[1].toLowerCase()))
      const aCoords = new Set(replyTags.filter(t => t[0] === 'a').map(t => (t[1] || '').toLowerCase()))
      filteredAuto = autoTags.filter(t => {
        if (t[0] === 'e' && eIds.has((t[1] || '').toLowerCase())) return false
        if (t[0] === 'p' && pIds.has((t[1] || '').toLowerCase())) return false
        if (t[0] === 'a' && aCoords.has((t[1] || '').toLowerCase())) return false
        return true
      })
    }

    return mergeTags({
      autoTags: [...replyTags, ...filteredAuto],
      zapSplits,
      userPubkey: user?.pubkey,
      userPct: userZapPct,
      manualTags,
    })
  }, [expandedContent, replyTags, zapSplits, user?.pubkey, userZapPct, manualTags])

  // Combined splits for preview display (includes user if their effective pct > 0)
  const previewZapSplits = useMemo(() => {
    const othersTotal = zapSplits.reduce((sum, z) => sum + (z.pct || 0), 0)
    const effectiveUserPct = userZapPct == null ? Math.max(0, 100 - othersTotal) : userZapPct
    if (user?.pubkey && effectiveUserPct > 0) {
      return [{ pubkey: user.pubkey, relay: '', pct: effectiveUserPct }, ...zapSplits]
    }
    return zapSplits
  }, [zapSplits, userZapPct, user?.pubkey])

  // Total number of recipients — matches what actually gets emitted as zap tags
  const zapSplitsCount = useMemo(() => {
    const hasAnySplit = zapSplits.length > 0 || userZapPct != null
    if (!hasAnySplit) return 0
    const othersCount = zapSplits.filter(z => z.pct > 0).length
    const othersTotal = zapSplits.reduce((sum, z) => sum + (z.pct || 0), 0)
    const effectiveUserPct = userZapPct == null ? Math.max(0, 100 - othersTotal) : userZapPct
    return othersCount + (effectiveUserPct > 0 ? 1 : 0)
  }, [zapSplits, userZapPct])

  // Prevent publishing when the configured splits total more than 100% —
  // zap wallets treat weights as a whole pie, so an over-100 sum leaves the
  // author with an ambiguous/invalid intent.
  const zapSplitOver100 = useMemo(() => {
    const othersTotal = zapSplits.reduce((sum, z) => sum + (z.pct || 0), 0)
    const effectiveUserPct = userZapPct == null ? Math.max(0, 100 - othersTotal) : userZapPct
    return othersTotal + effectiveUserPct > 100
  }, [zapSplits, userZapPct])

  const handlePublish = useCallback(async () => {
    if (onPublish) await onPublish()
  }, [onPublish])

  // Default scheduling time = next 15-min boundary AT LEAST MIN_LEAD_SECONDS
  // out. Returns separate date + time strings (YYYY-MM-DD and HH:MM)
  // matching the two field formats. So if it's 9:03 and min lead is
  // 15min → 9:30; if it's 9:14:59 → 9:30 (still snaps cleanly).
  const defaultScheduleLocal = useCallback(() => {
    const ts = Date.now() + MIN_LEAD_SECONDS * 1000
    const d = new Date(ts)
    const minutes = d.getMinutes()
    const next15 = Math.ceil(minutes / 15) * 15
    if (next15 === 60) {
      d.setHours(d.getHours() + 1)
      d.setMinutes(0, 0, 0)
    } else {
      d.setMinutes(next15, 0, 0)
    }
    const pad = n => String(n).padStart(2, '0')
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    }
  }, [])

  // Today's date (YYYY-MM-DD local) for the date input's `min`. Stops
  // users from picking a past day; per-second past-time still gets
  // caught by the validate-on-submit path in handleSchedule.
  const todayLocal = useMemo(() => {
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }, [])

  // Seed both fields the moment the user toggles "Schedule for later"
  // on, so they see a sensible default rather than empty inputs.
  useEffect(() => {
    if (scheduleMode && !scheduleDate && !scheduleTime) {
      const def = defaultScheduleLocal()
      setScheduleDate(def.date)
      setScheduleTime(def.time)
    }
  }, [scheduleMode, scheduleDate, scheduleTime, defaultScheduleLocal])

  // Auto-enable Schedule mode when the draft was hydrated from an
  // imported event whose created_at is in the future (set by
  // buildDraftSnapshotFromEvent). Runs once per draft mount because
  // the parent gives this component a `key={draft.id}`.
  useEffect(() => {
    const pa = initial.publishAt
    if (!pa || !Number.isFinite(pa)) return
    if (pa <= Math.floor(Date.now() / 1000) + 60) return
    setScheduleMode(true)
    const d = new Date(pa * 1000)
    const pad = (n) => String(n).padStart(2, '0')
    setScheduleDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    setScheduleTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  // Snapshot emitted upward to the parent hook so it can persist the draft
  // and expose `publishable` for Publish-all. Parent hook already debounces
  // localStorage writes, so this can fire on every change.
  //
  // Declared *before* handleExportJson because the export's _mynostr_form
  // sidecar reads the snapshot — putting it after the export would TDZ-
  // crash NoteComposer on every render via the useCallback deps array.
  const snapshot = useMemo(() => ({
    content,
    zapSplits,
    userZapPct: userZapPct === undefined ? null : userZapPct,
    manualTags,
    mentions: Object.fromEntries(mentions),
    replyToInput,
    replyTarget: null,
    quoteInput,
    quoteTarget: null,
    relayOverride,
    publishAt: initial.publishAt || null,
  }), [content, zapSplits, userZapPct, manualTags, mentions, replyToInput, quoteInput, relayOverride, initial.publishAt])

  // Export current note as a kind 1 JSON file. Includes a
  // `_mynostr_form` sidecar with the full snapshot — relayOverride,
  // zapSplits, mentions, reply/quote inputs — so re-importing into
  // mynostr restores the editor exactly. Other Nostr clients ignore
  // unknown top-level keys, so the event itself stays standards-
  // compliant.
  const handleExportJson = useCallback(() => {
    const event = {
      kind: 1,
      pubkey: user?.pubkey || '',
      created_at: Math.floor(Date.now() / 1000),
      content: expandedContent,
      tags: finalTags,
      _mynostr_form: snapshot,
    }
    const blob = new Blob([JSON.stringify(event, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `note-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [expandedContent, finalTags, user?.pubkey, snapshot])

  // Block publish when a reply/quote input has text but doesn't parse as a
  // note ID. Otherwise the note would go out silently missing its thread
  // tags — a "reply" that isn't threaded, or a quote that isn't embedded.
  const hasInvalidReply = Boolean(replyToInput.trim() && !replyToRef.valid)
  const hasInvalidQuote = Boolean(quoteInput.trim() && !quoteRef.valid)

  const publishable = useMemo(() => {
    if (!content.trim()) return null
    if (hasInvalidReply || hasInvalidQuote) return null
    return { content: expandedContent, tags: finalTags }
  }, [content, expandedContent, finalTags, hasInvalidReply, hasInvalidQuote])

  // Schedule handler — defined AFTER `publishable` because it captures
  // it. Validates the picked datetime against the worker's lead-time
  // floor and ceiling, signs + POSTs via lib/scheduler.
  const handleSchedule = useCallback(async () => {
    setScheduleError('')
    if (!scheduleDate || !scheduleTime) {
      setScheduleError('Pick a publish date and time first.')
      return
    }
    if (!publishable) {
      setScheduleError('Note is empty or has unresolved fields.')
      return
    }
    // Combine date + time into a local-tz Date. The string form
    // `YYYY-MM-DDTHH:MM` is parsed as local time by Date — same shape
    // the previous datetime-local input emitted, so server-side
    // semantics don't change.
    const publishUnixSec = Math.floor(new Date(`${scheduleDate}T${scheduleTime}`).getTime() / 1000)
    if (!Number.isFinite(publishUnixSec) || publishUnixSec <= 0) {
      setScheduleError('Invalid date/time.')
      return
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (publishUnixSec < nowSec + MIN_LEAD_SECONDS) {
      setScheduleError(`Pick a time at least ${MIN_LEAD_SECONDS / 60} minutes from now.`)
      return
    }
    if (publishUnixSec > nowSec + MAX_FUTURE_SECONDS) {
      setScheduleError('Pick a time within 30 days.')
      return
    }
    setScheduling(true)
    try {
      const res = await scheduleNote({
        content: publishable.content,
        tags:    publishable.tags,
        publishUnixSec,
      })
      setScheduleResult(res)
    } catch (e) {
      setScheduleError(e?.message || 'Schedule failed.')
    } finally {
      setScheduling(false)
    }
  }, [scheduleDate, scheduleTime, publishable])

  // Ref-wrap the callback so identity changes in the parent don't thrash
  // this effect — only real snapshot/publishable changes should emit.
  const onSnapshotChangeRef = useRef(onSnapshotChange)
  useEffect(() => { onSnapshotChangeRef.current = onSnapshotChange })
  useEffect(() => {
    onSnapshotChangeRef.current?.({ snapshot, publishable })
  }, [snapshot, publishable])

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="max-w-[400px] mx-auto px-4 py-5">
        {viewingScheduled && (
          <div className="mb-4 rounded-lg border border-blue-700/60 bg-blue-950/40 px-3 py-3 space-y-2">
            <p className="text-[11px] text-blue-200 leading-snug">
              <span className="font-medium">Scheduled.</span> This note is queued
              to publish at the time below. The fields are locked to keep the
              signed event intact — to change anything, cancel the schedule first
              and the composer becomes editable.
            </p>
            <button
              type="button"
              onClick={() => onCancelScheduled?.()}
              className="w-full py-2 rounded bg-red-600 hover:bg-red-500 text-sm text-white font-semibold transition-colors"
            >
              Cancel Scheduled Note
            </button>
          </div>
        )}
        {/* Wrap the editable surface in a disabled fieldset when viewing
            a scheduled item. `disabled` on a fieldset propagates to every
            form control inside, regardless of nesting depth — cleaner
            than threading a `disabled` prop through every input. The
            `contents` display strips the fieldset's default block layout
            so the wrapped tree renders identically to the non-locked
            case. */}
        <fieldset
          disabled={viewingScheduled}
          className="contents"
        >
        {/* Mobile-only drafts chip — desktop gets a persistent left column */}
        {isMobile && onOpenDraftsMobile && (
          <button
            onClick={onOpenDraftsMobile}
            className="w-full mb-3 flex items-center justify-center gap-1.5 py-2 text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-600 rounded-lg transition-colors"
            aria-label={`Open drafts (${draftCount})`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h5.379a1.5 1.5 0 0 1 1.06.44l2.122 2.12A1.5 1.5 0 0 1 13.5 5.62V12.5A1.5 1.5 0 0 1 12 14H4.5A1.5 1.5 0 0 1 3 12.5v-9Z" />
            </svg>
            <span>Drafts ({draftCount})</span>
          </button>
        )}

        {/* Hidden file input */}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Action row — source controls + inline search-by-ID field on the
            left, Clear pinned to the right. */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 px-2.5 py-2 sm:py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors text-xs text-neutral-400 shrink-0"
              title="Load a kind 1 event from a JSON file"
              aria-label="Load a kind 1 event from a JSON file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                <path d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03L9.25 4.636v8.614Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                </svg>
              <span className="hidden sm:inline">JSON</span>
            </button>
            <div className="relative w-28 shrink">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none">
                <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
              </svg>
              <input
                ref={importInputRef}
                type="text"
                placeholder="note ID"
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg pl-8 pr-2 py-2 sm:py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-purple-600 disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleImportById(e.target.value)
                  }
                }}
                disabled={importLoading}
                aria-label="Search for a note by ID"
              />
            </div>
            <button
              onClick={handleExportJson}
              disabled={!content.trim()}
              className="flex items-center gap-1.5 px-2.5 py-2 sm:py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors text-xs text-neutral-400 disabled:opacity-30 disabled:pointer-events-none shrink-0"
              title="Export note as JSON file"
              aria-label="Export note as JSON file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
              </svg>
              <span className="hidden sm:inline">Export</span>
            </button>
          </div>

          {!publishResult && !readOnly && (
            <button
              onClick={handleClearClick}
              disabled={!hasEditorState}
              className={`flex items-center gap-1 px-2.5 py-2 sm:py-1 rounded-lg text-xs border transition-colors disabled:opacity-40 disabled:pointer-events-none shrink-0 ${
                clearPending
                  ? 'bg-red-950/60 border-red-800 text-red-400'
                  : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-900'
              }`}
              title={clearPending ? 'Click again to confirm' : 'Clear editor and reset zap splits'}
              aria-label={clearPending ? 'Confirm clear' : 'Clear editor and reset zap splits'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5A.75.75 0 0 1 9.95 6Z" clipRule="evenodd" />
              </svg>
              <span className="hidden sm:inline">{clearPending ? 'Sure?' : 'Clear'}</span>
            </button>
          )}
        </div>

        {/* Import-by-ID status messages (the input itself lives in the
            action row above). */}
        {importLoading && (
          <p className="text-neutral-500 text-xs mb-3 italic">Loading note…</p>
        )}
        {importError && (
          <p className="text-red-400 text-xs mb-3">{importError}</p>
        )}

        {/* Publish result */}
        {publishResult ? (
          <div className="bg-green-900/30 border border-green-800 rounded-lg p-3">
            <p className="text-green-400 font-medium text-sm mb-2">Published!</p>
            <div className="space-y-1.5">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-neutral-500">note ID:</span>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(publishResult.noteId)
                        setIdCopied(true)
                        const id = setTimeout(() => {
                          pendingTimersRef.current.delete(id)
                          setIdCopied(false)
                        }, 2000)
                        pendingTimersRef.current.add(id)
                      } catch {}
                    }}
                    className="text-[10px] text-neutral-400 hover:text-neutral-200 border border-neutral-700 hover:border-neutral-500 rounded px-2 py-1 sm:py-0.5 transition-colors"
                    aria-label="Copy note ID"
                  >
                    {idCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <code className="text-[10px] text-green-300 bg-neutral-900 px-1.5 py-0.5 rounded break-all block mt-0.5">
                  {publishResult.noteId}
                </code>
              </div>
              <div>
                <a
                  href={`https://njump.me/${publishResult.nevent}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-purple-400 hover:text-purple-300 underline break-all"
                >
                  View on njump.me
                </a>
              </div>
              <p className="text-[10px] text-neutral-600 mt-1">
                {publishResult.relays.length} relay{publishResult.relays.length !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={() => {
                // Remove the just-published draft from the tray rather than
                // resetting it in place — a lingering "Published" entry made
                // the tray read as "old draft + new draft" after acking, when
                // the user's intent was simply to start fresh. Falls back to
                // handleClear if the parent didn't wire onAckPublished, so
                // the button still does *something* in older callers.
                if (onAckPublished) onAckPublished()
                else handleClear()
              }}
              className="mt-3 w-full py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-xs text-white font-medium transition-colors"
            >
              New Note
            </button>
          </div>
        ) : (
          <>
            {/* Reply-to — above the editor. When valid, the note becomes a
                NIP-10 reply: the target's author gets a p-tag and any
                existing thread root is preserved. Border tints track the
                parse state: neutral when empty, purple when a valid ID is
                pasted, red when the input is clearly not a note ID (npub,
                name, arbitrary text). */}
            <div className="mb-1.5">
              <div className="relative flex items-center">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500 uppercase tracking-wide font-semibold pointer-events-none">
                  Reply
                </span>
                <input
                  type="text"
                  value={replyToInput}
                  onChange={(e) => setReplyToInput(e.target.value)}
                  placeholder="note1…, nevent1…, or naddr1… to reply to"
                  className={`w-full bg-neutral-900 border rounded-lg pl-14 pr-7 py-2 sm:py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none ${
                    !replyToInput.trim()
                      ? 'border-neutral-800 focus:border-purple-600'
                      : replyToRef.valid
                        ? 'border-purple-600'
                        : 'border-red-700 focus:border-red-600'
                  }`}
                  aria-label="Reply to note ID"
                  aria-invalid={Boolean(replyToInput.trim() && !replyToRef.valid)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                {replyToInput && (
                  <button
                    onClick={() => setReplyToInput('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-neutral-500 hover:text-neutral-200 text-base leading-none"
                    aria-label="Clear reply target"
                  >×</button>
                )}
              </div>
              {replyToRef.valid && replyTargetLoading && (
                <p className="text-[10px] text-neutral-500 italic mt-0.5 pl-1">Loading reply target…</p>
              )}
              {replyTargetError && !replyTargetLoading && (
                <p className="text-[10px] text-red-400 mt-0.5 pl-1">{replyTargetError}</p>
              )}
              {replyToRef.valid && replyTargetEvent && !replyTargetLoading && (
                replyTargetEvent.addressable
                  ? replyTargetEvent.aCoord === replyToRef.aCoord
                  : replyTargetEvent.id === replyToRef.id
              ) && (
                <p className="text-[10px] text-green-500 mt-0.5 pl-1">✓ Ready to reply</p>
              )}
            </div>

            {/* Compose (Write mode) — hidden in preview mode. */}
            {!previewMode && (
              <div className="relative bg-neutral-900 rounded-lg">
                <EditorMirror content={content} mentionNames={[...mentions.keys()]} />
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value)
                    setCursorPos(e.target.selectionStart)
                    const ta = textareaRef.current
                    if (ta) {
                      ta.style.height = 'auto'
                      ta.style.height = Math.max(ta.scrollHeight, TEXTAREA_MIN_H) + 'px'
                    }
                  }}
                  onKeyUp={(e) => setCursorPos(e.target.selectionStart)}
                  onClick={(e) => setCursorPos(e.target.selectionStart)}
                  className="w-full bg-transparent border border-neutral-700 rounded-lg p-3 text-[15px] text-transparent caret-neutral-100 placeholder:text-neutral-600 leading-relaxed focus:border-purple-600 focus:outline-none overflow-hidden resize-none font-sans relative z-10"
                  style={{ minHeight: TEXTAREA_MIN_H, height: TEXTAREA_MIN_H }}
                  placeholder="What do you want to say?"
                  autoComplete="off"
                  autoFocus={!isMobile}
                />
                <MentionAutocomplete
                  textareaRef={textareaRef}
                  content={content}
                  cursorPos={cursorPos}
                  onSelect={handleMentionSelect}
                  onActiveChange={setMentionActive}
                />
              </div>
            )}

            {/* Preview mode — full preview in place of the editor. Uses a
                compact zap-split display (pfp + %, no names). When a reply
                target is set, surface it as a card at the top so the author
                can sanity-check the thread they're entering. */}
            {previewMode && (
              <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-3">
                {replyToRef.valid && (
                  <div className="mb-3">
                    <p className="text-[10px] text-neutral-500 uppercase tracking-wide font-semibold mb-1">
                      Replying to
                    </p>
                    <EmbeddedNoteCard nip19Str={replyToRef.bech32} />
                  </div>
                )}
                {(content.trim() || quoteRef.valid) ? (
                  <NotePreview
                    content={expandedContent}
                    zapSplits={previewZapSplits}
                    authorPubkey={user?.pubkey}
                    compactSplits
                    showZapSplits={zapSplits.length > 0 || userZapPct != null}
                  />
                ) : !replyToRef.valid ? (
                  <p className="text-neutral-700 text-xs italic">Nothing to preview yet — switch back to Write.</p>
                ) : null}
              </div>
            )}

            {/* Quote — below the editor. The nevent is appended to the
                published content so every client renders it as an embed,
                and extractTags() picks it up as a 'mention' e-tag. Border
                tint mirrors the Reply field — purple on valid parse, red
                on bad input. */}
            <div className="mt-1.5">
              <div className="relative flex items-center">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500 uppercase tracking-wide font-semibold pointer-events-none">
                  Quote
                </span>
                <input
                  type="text"
                  value={quoteInput}
                  onChange={(e) => setQuoteInput(e.target.value)}
                  placeholder="note1…, nevent1…, or naddr1… to quote"
                  className={`w-full bg-neutral-900 border rounded-lg pl-14 pr-7 py-2 sm:py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none ${
                    !quoteInput.trim()
                      ? 'border-neutral-800 focus:border-purple-600'
                      : quoteRef.valid
                        ? 'border-purple-600'
                        : 'border-red-700 focus:border-red-600'
                  }`}
                  aria-label="Quote note ID"
                  aria-invalid={Boolean(quoteInput.trim() && !quoteRef.valid)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                {quoteInput && (
                  <button
                    onClick={() => setQuoteInput('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-neutral-500 hover:text-neutral-200 text-base leading-none"
                    aria-label="Clear quote"
                  >×</button>
                )}
              </div>
            </div>

            {/* Toolbar row — image upload + zap splits only in Write mode,
                Write/Preview pill ALWAYS visible (pinned right) so you can
                toggle back from preview. */}
            <div className="flex items-center gap-2 mt-1.5">
              {!previewMode && (
                <>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*,video/mp4,video/quicktime,video/webm,video/x-m4v"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        if (file.type.startsWith('image/')) handleImageUpload(file)
                        else handleVideoUpload(file)
                      }
                      e.target.value = ''
                    }}
                  />
                  <button
                    onClick={() => imageInputRef.current?.click()}
                    disabled={imageUploading || videoUploading || readOnly}
                    className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 rounded text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-500 border border-neutral-700 transition-colors disabled:opacity-50"
                    title="Upload image or video (MP4, MOV, WebM, M4V — up to 50 MB)"
                    aria-label="Upload media"
                  >
                    {imageUploading || videoUploading ? (
                      <>
                        <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
                        <span>Uploading...</span>
                      </>
                    ) : (
                      <>
                        {/* Image glyph (frame + mountain) */}
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <path fillRule="evenodd" d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm10.5 5.707a.5.5 0 0 0-.146-.353l-2.5-2.5a.5.5 0 0 0-.708 0L7.5 8.5 6.354 7.354a.5.5 0 0 0-.708 0l-2 2A.5.5 0 0 0 3.5 10v1.5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V9.707ZM6.5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                        </svg>
                        {/* Upload glyph */}
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                          <path d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03L9.25 4.636v8.614Z" />
                          <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                        </svg>
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => setShowAdvanced(v => !v)}
                    className={`flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 rounded text-xs transition-colors ${
                      showAdvanced
                        ? 'bg-yellow-900/40 text-yellow-300 border border-yellow-800'
                        : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-500 border border-neutral-700'
                    }`}
                  >
                    <span>⚡</span>
                    <span>Splits{zapSplitsCount > 0 ? ` (${zapSplitsCount})` : ''}</span>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                    >
                      <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                    </svg>
                  </button>

                  <button
                    onClick={() => setShowRelayOptions(v => !v)}
                    title="Advanced options"
                    aria-label="Advanced options"
                    className={`flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 rounded text-xs transition-colors ${
                      showRelayOptions
                        ? 'bg-amber-900/40 text-amber-300 border border-amber-800'
                        : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-500 border border-neutral-700'
                    }`}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
                    </svg>
                    {relayOverride.enabled && <span className="text-[10px]">•</span>}
                  </button>
                </>
              )}

              {/* Write/Preview pill — always visible, pinned right. */}
              <div className="ml-auto flex items-center bg-neutral-900 border border-neutral-800 rounded p-0.5 shrink-0">
                <button
                  onClick={() => setPreviewMode(false)}
                  aria-pressed={!previewMode}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    !previewMode ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  Write
                </button>
                <button
                  onClick={() => setPreviewMode(true)}
                  aria-pressed={previewMode}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    previewMode ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  Preview
                </button>
              </div>
            </div>

            {/* Image / upload errors — Write mode only */}
            {!previewMode && imageError && (
              <p className="text-red-400 text-xs mt-1">{imageError}</p>
            )}
            {!previewMode && videoError && (
              <p className="text-red-400 text-xs mt-1">{videoError}</p>
            )}
            {!previewMode && uploadError && (
              <div className="mt-2 bg-red-900/30 border border-red-800 rounded p-2 flex items-center justify-between">
                <p className="text-red-400 text-xs">{uploadError}</p>
                <button onClick={() => setUploadError(null)} className="text-red-500 hover:text-red-300 text-sm leading-none ml-2">×</button>
              </div>
            )}

            {publishError && (
              <div className="mt-2 bg-red-900/30 border border-red-800 rounded p-2">
                <p className="text-red-400 text-xs">{publishError}</p>
              </div>
            )}

            {/* Publish / Schedule button + scheduling panel.
                When viewingScheduled, this block is replaced by an
                inline display of the locked schedule date+time so the
                user can see WHEN this is scheduled — the action itself
                (Cancel) lives in the top banner. */}
            <div className="mt-3">
              {viewingScheduled ? (
                <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2.5 space-y-1.5">
                  <p className="text-[11px] text-neutral-400">Publish at (your local time)</p>
                  <div className="flex gap-2">
                    <input
                      type="date"
                      value={scheduleDate}
                      readOnly
                      className="flex-1 bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-300 cursor-not-allowed"
                    />
                    <input
                      type="text"
                      value={scheduleTime ? format12h(scheduleTime) : ''}
                      readOnly
                      className="w-32 bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-300 cursor-not-allowed text-center"
                    />
                  </div>
                  <p className="text-[10px] text-neutral-600">
                    Locked. Cancel above to edit.
                  </p>
                </div>
              ) : !readOnly ? (
                scheduleResult ? (
                  // Success view — composer body is now stale, prompt the
                  // user to clear so a fresh draft replaces it.
                  <div className="rounded-lg border border-green-800/60 bg-green-950/20 px-3 py-3 space-y-2">
                    <p className="text-green-400 font-medium text-sm">Scheduled!</p>
                    <p className="text-[11px] text-neutral-400 leading-snug">
                      This note will publish at{' '}
                      <span className="text-neutral-200">
                        {new Date(scheduleResult.scheduledFor * 1000).toLocaleString()}
                      </span>.
                      It now sits in your drafts list (blue card with a clock).
                      Cancel from there any time before it fires.
                    </p>
                    <button
                      onClick={() => {
                        setScheduleResult(null)
                        setScheduleMode(false)
                        setScheduleDate('')
                        setScheduleTime('')
                        handleClear()
                      }}
                      className="w-full py-2 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-200 transition-colors"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={scheduleMode ? handleSchedule : handlePublish}
                      disabled={
                        (scheduleMode ? scheduling : publishing) ||
                        !content.trim() ||
                        zapSplitOver100 ||
                        hasInvalidReply ||
                        hasInvalidQuote
                      }
                      className={`w-full py-3 sm:py-2 disabled:bg-neutral-700 disabled:text-neutral-500 rounded-lg text-sm text-white font-semibold transition-colors ${
                        scheduleMode
                          ? 'bg-blue-600 hover:bg-blue-500'
                          : 'bg-purple-600 hover:bg-purple-500'
                      }`}
                    >
                      {scheduleMode
                        ? (scheduling ? 'Scheduling…' : 'SCHEDULE')
                        : (publishing ? 'Publishing...' : 'PUBLISH')}
                    </button>

                    {schedulerEnabled && (
                      <label className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500 select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={scheduleMode}
                          onChange={e => {
                            setScheduleMode(e.target.checked)
                            setScheduleError('')
                          }}
                          className="accent-blue-600"
                        />
                        <span>🕐 Schedule for later</span>
                      </label>
                    )}

                    {scheduleMode && (
                      <div className="mt-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2.5 space-y-1.5">
                        <label className="block text-[11px] text-neutral-400">
                          Publish at (your local time)
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="date"
                            value={scheduleDate}
                            min={todayLocal}
                            onChange={e => { setScheduleDate(e.target.value); setScheduleError('') }}
                            className="flex-1 bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-purple-600"
                          />
                          <TimePicker
                            value={scheduleTime}
                            onChange={v => { setScheduleTime(v); setScheduleError('') }}
                            className="w-32"
                          />
                        </div>
                        <p className="text-[10px] text-neutral-600 leading-snug">
                          Earliest: {MIN_LEAD_SECONDS / 60} min from now. Up to 30 days out.
                          15-minute slots.
                        </p>
                        {scheduleError && (
                          <p className="text-[11px] text-red-400">{scheduleError}</p>
                        )}
                      </div>
                    )}

                    {zapSplitOver100 && (
                      <p className="mt-2 text-[11px] text-red-400">
                        Zap splits total more than 100%. Adjust the splits before publishing.
                      </p>
                    )}
                    {hasInvalidReply && (
                      <p className="mt-2 text-[11px] text-red-400">
                        Reply field needs a valid note ID (note1…, nevent1…, or naddr1…) — or clear it before publishing.
                      </p>
                    )}
                    {hasInvalidQuote && (
                      <p className="mt-2 text-[11px] text-red-400">
                        Quote field needs a valid note ID (note1…, nevent1…, or naddr1…) — or clear it before publishing.
                      </p>
                    )}
                  </>
                )
              ) : (
                <div className="w-full py-2 bg-neutral-800 rounded-lg text-xs text-amber-500 font-medium text-center">
                  Read-only mode
                </div>
              )}
            </div>

            {/* Zap splits — editing UI is write-mode only */}
            {!previewMode && showAdvanced && (
              <ZapSplitsSection
                zapSplits={zapSplits}
                onZapSplitsChange={setZapSplits}
                userPubkey={user?.pubkey}
                userZapPct={userZapPct}
                onUserZapPctChange={setUserZapPct}
              />
            )}

            {/* Advanced (gear) — relay override today; future: more options */}
            {!previewMode && showRelayOptions && (
              <RelayOverrideSection
                relayOverride={relayOverride}
                onChange={setRelayOverride}
              />
            )}
          </>
        )}
        </fieldset>
      </div>
      {uploadPicker}
    </div>
  )
}
