/**
 * NotesModule — Module 2
 * Kind 1 short note composer with live preview below.
 * Phone-width layout even on desktop — notes are mobile content.
 */
import { useState, useCallback, useMemo, useRef, useLayoutEffect, useEffect } from 'react'
import ZapSplitsSection from './components/NoteEditor.jsx'
import NotePreview from './components/NotePreview.jsx'
import MentionAutocomplete from './components/MentionAutocomplete.jsx'
import EditorMirror from './components/EditorMirror.jsx'
import { nip19 } from 'nostr-tools'
import { fetchProfiles } from '../../lib/primal.js'
import { extractTags, mergeTags, validateKind1Event } from '../../lib/noteParser.js'
import { publishNote } from '../../lib/publishNote.js'
import { getNDK } from '../../lib/ndk.js'
import { uploadToBlossom } from '../../lib/blossom.js'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { useOwnerContext } from '../../lib/ownerContext.jsx'

// Compact default heights — phone-like proportions
const TEXTAREA_MIN_H = 100
const PREVIEW_COLLAPSED_H = 200

export default function NotesModule({ user }) {
  const { isOwner } = useOwnerContext()
  const readOnly = !!user?.readOnly
  const isMobile = useIsMobile()
  const fileRef = useRef(null)
  const [idCopied, setIdCopied] = useState(false)

  // Core state
  const [content, setContent] = useState('')
  const [zapSplits, setZapSplits] = useState([])
  // undefined = auto (catch remainder); number = explicit user pct
  const [userZapPct, setUserZapPct] = useState(undefined)
  const [manualTags, setManualTags] = useState([])

  // UI state
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const [previewOverflows, setPreviewOverflows] = useState(false)
  const previewInnerRef = useRef(null)
  const textareaRef = useRef(null)
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState(null)
  const [publishError, setPublishError] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState('')
  const imageInputRef = useRef(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [mentionActive, setMentionActive] = useState(false)
  const mentionsMap = useRef(new Map()) // displayName → pubkey
  const [showImportId, setShowImportId] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const importInputRef = useRef(null)
  const [clearPending, setClearPending] = useState(false)
  const clearTimerRef = useRef(null)

  // Auto-cancel the clear-confirm state after 3s if user doesn't follow through
  useEffect(() => {
    if (clearPending) {
      clearTimerRef.current = setTimeout(() => setClearPending(false), 3000)
    }
    return () => clearTimeout(clearTimerRef.current)
  }, [clearPending])

  // Resize textarea to fit content whenever it changes (covers programmatic sets like JSON import)
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.max(ta.scrollHeight, TEXTAREA_MIN_H) + 'px'
  }, [content])

  // Check if preview content overflows (also re-check when images/media load)
  const checkOverflow = useCallback(() => {
    const inner = previewInnerRef.current
    if (!inner) return
    setPreviewOverflows(inner.scrollHeight > PREVIEW_COLLAPSED_H - 24)
  }, [])

  useLayoutEffect(() => {
    checkOverflow()
    // Also listen for image/video loads inside the preview
    const inner = previewInnerRef.current
    if (!inner) return
    inner.addEventListener('load', checkOverflow, true)
    return () => inner.removeEventListener('load', checkOverflow, true)
  }, [content, zapSplits, checkOverflow])

  // Shared: load a kind 1 event object into the editor
  const loadEventIntoEditor = useCallback(async (eventObj) => {
    mentionsMap.current.clear()

    // Convert nostr:npub1... in content to @DisplayName
    let loadedContent = eventObj.content || ''
    const npubRe = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)/g
    const npubMatches = [...loadedContent.matchAll(npubRe)]
    if (npubMatches.length > 0) {
      const pubkeys = []
      const matchMap = []
      for (const m of npubMatches) {
        try {
          const decoded = nip19.decode(m[1])
          const pk = decoded.type === 'npub' ? decoded.data : decoded.data?.pubkey
          if (pk) { pubkeys.push(pk); matchMap.push({ fullMatch: m[0], pubkey: pk }) }
        } catch {}
      }
      if (pubkeys.length > 0) {
        try {
          const profiles = await fetchProfiles([...new Set(pubkeys)])
          for (const { fullMatch, pubkey } of matchMap) {
            const p = profiles.get(pubkey)
            const name = p?.display_name || p?.name || nip19.npubEncode(pubkey).slice(0, 12)
            let displayName = name
            if (mentionsMap.current.has(displayName) && mentionsMap.current.get(displayName) !== pubkey) {
              displayName = `${name}_${nip19.npubEncode(pubkey).slice(5, 9)}`
            }
            mentionsMap.current.set(displayName, pubkey)
            loadedContent = loadedContent.replaceAll(fullMatch, `@${displayName}`)
          }
        } catch {}
      }
    }

    setContent(loadedContent)
    setPublishResult(null)
    setPublishError(null)

    const tags = eventObj.tags || []
    // Normalize all zap weights together (including user's own), then split user out.
    // Preserves the original proportions from the JSON — if the author gave themselves 0,
    // we respect that instead of auto-injecting a remainder.
    const userHex = (user?.pubkey || '').toLowerCase()
    // Accept hex (any case) or npub/nprofile in the tag's pubkey slot.
    const toHex = (v) => {
      if (typeof v !== 'string') return ''
      const s = v.trim()
      if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase()
      try {
        const d = nip19.decode(s)
        if (d.type === 'npub') return d.data.toLowerCase()
        if (d.type === 'nprofile') return (d.data.pubkey || '').toLowerCase()
      } catch {}
      return ''
    }

    const allZaps = tags
      .filter(t => t[0] === 'zap' && t[1])
      .map(t => ({ hex: toHex(t[1]), relay: t[2] || '', weight: Number(t[3]) || 1 }))
      .filter(t => t.hex)
    const totalWeight = allZaps.reduce((sum, t) => sum + t.weight, 0)

    let importedUserPct
    const others = []
    for (const t of allZaps) {
      const pct = totalWeight > 0 ? Math.round((t.weight / totalWeight) * 100) : 0
      if (userHex && t.hex === userHex) {
        importedUserPct = pct
      } else {
        others.push({ pubkey: t.hex, relay: t.relay, pct })
      }
    }
    setZapSplits(others)
    // If the original had any zap tags but didn't include the user, explicitly set user to 0
    // so we don't auto-inject them as the remainder.
    setUserZapPct(importedUserPct != null ? importedUserPct : (allZaps.length > 0 ? 0 : undefined))

    const autoTagTypes = new Set(['p', 't', 'e', 'a', 'zap', 'client'])
    setManualTags(tags.filter(t => !autoTagTypes.has(t[0])))

    if (allZaps.length > 0) setShowAdvanced(true)
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
    setPublishResult(null)
    setPublishError(null)
    setUploadError(null)
    setShowAdvanced(false)
    setPreviewExpanded(false)
    setShowImportId(false)
    setImportError('')
    setClearPending(false)
    mentionsMap.current.clear()
  }, [])

  const handleClearClick = useCallback(() => {
    if (!clearPending) { setClearPending(true); return }
    handleClear()
  }, [clearPending, handleClear])

  // Show the Clear button only when there's something worth clearing
  const hasEditorState = !!(content.trim() || zapSplits.length || userZapPct != null || manualTags.length)

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
      for (const r of relayHints) {
        if (typeof r === 'string' && r.startsWith('wss://')) {
          try { ndk.addExplicitRelay(r) } catch {}
        }
      }

      const waitStart = Date.now()
      while (!ndk.pool.connectedRelays().length && Date.now() - waitStart < 3000) {
        await new Promise(r => setTimeout(r, 100))
      }

      let event = await ndk.fetchEvent({ ids: [eventId] })
      if (!event) {
        await new Promise(r => setTimeout(r, 2000))
        event = await ndk.fetchEvent({ ids: [eventId] })
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
      setShowImportId(false)
    } catch (e) {
      setImportError(e.message || 'Failed to import note')
    } finally {
      setImportLoading(false)
    }
  }, [loadEventIntoEditor])

  // Image upload — insert URL at cursor position
  const handleImageUpload = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return
    if (imageUploading) return
    setImageUploading(true)
    setImageError('')
    try {
      const url = await uploadToBlossom(file)
      const ta = textareaRef.current
      const cursorPos = ta?.selectionStart ?? content.length
      const before = content.slice(0, cursorPos)
      const after = content.slice(cursorPos)
      // Add spacing around the URL
      const needsBefore = before.length > 0 && !before.endsWith('\n') && !before.endsWith(' ')
      const needsAfter = after.length > 0 && !after.startsWith('\n') && !after.startsWith(' ')
      const newContent = before + (needsBefore ? '\n' : '') + url + (needsAfter ? '\n' : '') + after
      setContent(newContent)
    } catch (err) {
      setImageError(err.message || 'Image upload failed')
      setTimeout(() => setImageError(''), 5000)
    } finally {
      setImageUploading(false)
    }
  }, [content, imageUploading])

  // Handle @mention selection — insert @DisplayName, track mapping
  const handleMentionSelect = useCallback(({ name, pubkey }, start, end) => {
    // Ensure unique display name in the map
    let displayName = name
    if (mentionsMap.current.has(displayName) && mentionsMap.current.get(displayName) !== pubkey) {
      const short = nip19.npubEncode(pubkey).slice(5, 9)
      displayName = `${name}_${short}`
    }
    mentionsMap.current.set(displayName, pubkey)

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
  }, [content])

  // Expand @DisplayName tokens back to nostr:npub1... for publish/preview/export
  const expandedContent = useMemo(() => {
    let text = content
    for (const [name, pubkey] of mentionsMap.current) {
      const npub = nip19.npubEncode(pubkey)
      text = text.replaceAll(`@${name}`, `nostr:${npub}`)
    }
    return text
  }, [content])

  const finalTags = useMemo(() => {
    const autoTags = extractTags(expandedContent)
    return mergeTags({ autoTags, zapSplits, userPubkey: user?.pubkey, userPct: userZapPct, manualTags })
  }, [expandedContent, zapSplits, user?.pubkey, userZapPct, manualTags])

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

  // Export current note as a kind 1 JSON file
  const handleExportJson = useCallback(() => {
    const event = {
      kind: 1,
      pubkey: user?.pubkey || '',
      created_at: Math.floor(Date.now() / 1000),
      content: expandedContent,
      tags: finalTags,
    }
    const blob = new Blob([JSON.stringify(event, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `note-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [expandedContent, finalTags, user?.pubkey])

  const handlePublish = useCallback(async () => {
    setPublishing(true)
    setPublishError(null)
    setPublishResult(null)

    try {
      const result = await publishNote({ content: expandedContent, tags: finalTags })
      setPublishResult(result)
    } catch (e) {
      setPublishError(e.message || 'Publishing failed')
    } finally {
      setPublishing(false)
    }
  }, [expandedContent, finalTags])

  // Visitor / read-only mode — the full note-viewing stream is a later phase.
  // For now, show a placeholder instead of the composer.
  if (!isOwner) {
    const displayName = user?.profile?.displayName || user?.profile?.name || 'this user'
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-sm mx-auto px-4 py-12 text-center">
          <div className="text-3xl text-neutral-700 mb-4">📝</div>
          <p className="text-sm text-neutral-300 mb-2">Notes by {displayName}</p>
          <p className="text-xs text-neutral-600 leading-relaxed">
            A public feed of this user's short notes is coming soon.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-sm mx-auto px-4 py-5">
        {/* Hidden file input */}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-base font-semibold text-neutral-100">Create a Note</h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 px-2.5 py-2 sm:py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors text-xs text-neutral-400"
              title="Load a kind 1 event from a JSON file"
              aria-label="Load a kind 1 event from a JSON file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                <path d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03L9.25 4.636v8.614Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
              </svg>
              <span className="hidden sm:inline">JSON</span>
            </button>
            <button
              onClick={handleExportJson}
              disabled={!content.trim()}
              className="flex items-center gap-1.5 px-2.5 py-2 sm:py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors text-xs text-neutral-400 disabled:opacity-30 disabled:pointer-events-none"
              title="Export note as JSON file"
              aria-label="Export note as JSON file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
              </svg>
              <span className="hidden sm:inline">Export</span>
            </button>
            <button
              onClick={() => { setShowImportId(v => !v); setImportError('') }}
              className={`flex items-center gap-1.5 px-2.5 py-2 sm:py-1 border rounded-lg transition-colors text-xs ${
                showImportId
                  ? 'bg-purple-900/40 text-purple-300 border-purple-800'
                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-400 border-neutral-700'
              }`}
              title="Import note by ID (note1 or nevent1)"
              aria-label="Import note by ID"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
              </svg>
              <span className="hidden sm:inline">ID</span>
            </button>
          </div>
        </div>

        {/* Import by note ID */}
        {showImportId && (
          <div className="mb-3">
            <div className="flex gap-1.5">
              <input
                ref={importInputRef}
                type="text"
                placeholder="Paste note1... or nevent1..."
                className="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-purple-600"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleImportById(e.target.value)
                  }
                }}
                disabled={importLoading}
              />
              <button
                onClick={() => handleImportById(importInputRef.current?.value || '')}
                disabled={importLoading}
                className="px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 rounded-lg text-xs text-white font-medium transition-colors"
              >
                {importLoading ? '...' : 'Pull'}
              </button>
            </div>
            {importError && <p className="text-red-400 text-xs mt-1.5">{importError}</p>}
          </div>
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
                        setTimeout(() => setIdCopied(false), 2000)
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
              onClick={handleClear}
              className="mt-3 w-full py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-xs text-white font-medium transition-colors"
            >
              New Note
            </button>
          </div>
        ) : (
          <>
            {/* Compose */}
            <div className="relative bg-neutral-900 rounded-lg">
              <EditorMirror content={content} mentionNames={[...mentionsMap.current.keys()]} />
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

            {/* Toolbar row: image upload + zap splits */}
            <div className="flex items-center gap-2 mt-1.5">
              {/* Image upload */}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImageUpload(file)
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => imageInputRef.current?.click()}
                disabled={imageUploading || readOnly}
                className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 rounded text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-500 border border-neutral-700 transition-colors disabled:opacity-50"
                title="Upload image"
              >
                {imageUploading ? (
                  <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path fillRule="evenodd" d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm10.5 5.707a.5.5 0 0 0-.146-.353l-2.5-2.5a.5.5 0 0 0-.708 0L7.5 8.5 6.354 7.354a.5.5 0 0 0-.708 0l-2 2A.5.5 0 0 0 3.5 10v1.5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V9.707ZM6.5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                  </svg>
                )}
                <span>{imageUploading ? 'Uploading...' : 'Image'}</span>
              </button>

              {/* Zap splits */}
              <button
                onClick={() => setShowAdvanced(v => !v)}
                className={`flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 rounded text-xs transition-colors ${
                  showAdvanced
                    ? 'bg-yellow-900/40 text-yellow-300 border border-yellow-800'
                    : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-500 border border-neutral-700'
                }`}
              >
                <span>⚡</span>
                <span>Zap Splits{zapSplitsCount > 0 ? ` (${zapSplitsCount})` : ''}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                >
                  <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
              </button>

              {/* Clear — pushed right; always visible alongside Image/Zap toolbar buttons */}
              {!readOnly && (
                <button
                  onClick={handleClearClick}
                  disabled={!hasEditorState}
                  className={`ml-auto flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 rounded text-xs border transition-colors disabled:opacity-40 disabled:pointer-events-none ${
                    clearPending
                      ? 'bg-red-950/60 border-red-800 text-red-400'
                      : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-500 hover:text-red-400 hover:border-red-900'
                  }`}
                  title={clearPending ? 'Click again to confirm' : 'Clear editor and reset zap splits'}
                  aria-label={clearPending ? 'Confirm clear' : 'Clear editor and reset zap splits'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5A.75.75 0 0 1 9.95 6Z" clipRule="evenodd" />
                  </svg>
                  <span>{clearPending ? 'Sure?' : 'Clear'}</span>
                </button>
              )}
            </div>

            {/* Image upload error */}
            {imageError && (
              <p className="text-red-400 text-xs mt-1">{imageError}</p>
            )}

            {/* Errors */}
            {uploadError && (
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

            {/* Publish button */}
            <div className="mt-3">
              {!readOnly ? (
                <>
                  {zapSplitOver100 && (
                    <p className="mb-2 text-[11px] text-red-400">
                      Zap splits total more than 100%. Adjust the splits before publishing.
                    </p>
                  )}
                  <button
                    onClick={handlePublish}
                    disabled={publishing || !content.trim() || zapSplitOver100}
                    className="w-full py-3 sm:py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-500 rounded-lg text-sm text-white font-semibold transition-colors"
                  >
                    {publishing ? 'Publishing...' : 'PUBLISH'}
                  </button>
                </>
              ) : (
                <div className="w-full py-2 bg-neutral-800 rounded-lg text-xs text-amber-500 font-medium text-center">
                  Read-only mode
                </div>
              )}
            </div>

            {/* Zap splits */}
            {showAdvanced && (
              <ZapSplitsSection
                zapSplits={zapSplits}
                onZapSplitsChange={setZapSplits}
                userPubkey={user?.pubkey}
                userZapPct={userZapPct}
                onUserZapPctChange={setUserZapPct}
              />
            )}

            {/* Preview — always visible */}
            <div className="mt-4">
              <p className="text-[10px] font-medium text-neutral-600 uppercase tracking-wide mb-1.5">Preview</p>
              <div
                className={`relative bg-neutral-900/50 border border-neutral-800 rounded-lg p-3 transition-all ${
                  !previewExpanded ? 'overflow-hidden' : ''
                }`}
                style={!previewExpanded ? { maxHeight: PREVIEW_COLLAPSED_H } : undefined}
              >
                <div ref={previewInnerRef}>
                  {content.trim() ? (
                    <NotePreview
                      content={expandedContent}
                      zapSplits={previewZapSplits}
                      authorPubkey={user?.pubkey}
                    />
                  ) : (
                    <p className="text-neutral-700 text-xs italic">Start typing to see a preview...</p>
                  )}
                </div>

                {!previewExpanded && previewOverflows && (
                  <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center">
                    <div className="w-full h-12 bg-gradient-to-t from-neutral-950/90 to-transparent" />
                    <button
                      onClick={() => setPreviewExpanded(true)}
                      className="absolute bottom-2 px-4 py-1.5 sm:px-3 sm:py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-full text-xs sm:text-[10px] text-neutral-300 transition-colors"
                    >
                      Show more
                    </button>
                  </div>
                )}
              </div>
              {previewExpanded && previewOverflows && (
                <button
                  onClick={() => setPreviewExpanded(false)}
                  className="mt-1.5 text-[10px] text-neutral-600 hover:text-neutral-400 transition-colors"
                >
                  Show less
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
