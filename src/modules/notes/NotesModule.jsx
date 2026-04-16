/**
 * NotesModule — Module 2
 * Kind 1 short note composer with live preview below.
 * Phone-width layout even on desktop — notes are mobile content.
 */
import { useState, useCallback, useMemo, useRef, useLayoutEffect } from 'react'
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

// Compact default heights — phone-like proportions
const TEXTAREA_MIN_H = 100
const PREVIEW_COLLAPSED_H = 200

export default function NotesModule({ user }) {
  const readOnly = !!user?.readOnly
  const fileRef = useRef(null)

  // Core state
  const [content, setContent] = useState('')
  const [zapSplits, setZapSplits] = useState([])
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
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, TEXTAREA_MIN_H) + 'px' }
    })

    const tags = eventObj.tags || []
    const rawZaps = tags.filter(t => t[0] === 'zap' && t[1] && t[1] !== user?.pubkey)
    const totalWeight = rawZaps.reduce((sum, t) => sum + (Number(t[3]) || 1), 0)
    setZapSplits(rawZaps.map(t => ({
      pubkey: t[1],
      relay: t[2] || '',
      pct: totalWeight > 0 ? Math.round(((Number(t[3]) || 1) / totalWeight) * 100) : Math.round(100 / rawZaps.length),
    })))

    const autoTagTypes = new Set(['p', 't', 'e', 'a', 'zap', 'client'])
    setManualTags(tags.filter(t => !autoTagTypes.has(t[0])))

    if (rawZaps.length > 0) setShowAdvanced(true)
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
    setManualTags([])
    setPublishResult(null)
    setPublishError(null)
    setUploadError(null)
    setShowAdvanced(false)
    setPreviewExpanded(false)
    mentionsMap.current.clear()
  }, [])

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
      // Auto-grow textarea
      if (ta) {
        requestAnimationFrame(() => {
          ta.style.height = 'auto'
          ta.style.height = Math.max(ta.scrollHeight, TEXTAREA_MIN_H) + 'px'
        })
      }
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
    return mergeTags({ autoTags, zapSplits, userPubkey: user?.pubkey, manualTags })
  }, [expandedContent, zapSplits, user?.pubkey, manualTags])

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
              className="flex items-center gap-1.5 px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors text-xs text-neutral-400"
              title="Load a kind 1 event from a JSON file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03L9.25 4.636v8.614Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
              </svg>
              JSON
            </button>
            <button
              onClick={handleExportJson}
              disabled={!content.trim()}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors text-xs text-neutral-400 disabled:opacity-30 disabled:pointer-events-none"
              title="Export note as JSON file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
              </svg>
              Export
            </button>
            <button
              onClick={() => { setShowImportId(v => !v); setImportError('') }}
              className={`flex items-center gap-1.5 px-2.5 py-1 border rounded-lg transition-colors text-xs ${
                showImportId
                  ? 'bg-purple-900/40 text-purple-300 border-purple-800'
                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-400 border-neutral-700'
              }`}
              title="Import note by ID (note1 or nevent1)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
              </svg>
              ID
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
                <span className="text-[10px] text-neutral-500">note ID:</span>
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
                autoFocus
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
                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-500 border border-neutral-700 transition-colors disabled:opacity-50"
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
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                  showAdvanced
                    ? 'bg-yellow-900/40 text-yellow-300 border border-yellow-800'
                    : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-500 border border-neutral-700'
                }`}
              >
                <span>⚡</span>
                <span>Zap Splits{zapSplits.length > 0 ? ` (${zapSplits.length})` : ''}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                >
                  <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
              </button>
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
                <button
                  onClick={handlePublish}
                  disabled={publishing || !content.trim()}
                  className="w-full py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-500 rounded-lg text-sm text-white font-semibold transition-colors"
                >
                  {publishing ? 'Publishing...' : 'PUBLISH'}
                </button>
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
                      zapSplits={zapSplits}
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
                      className="absolute bottom-2 px-3 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-full text-[10px] text-neutral-300 transition-colors"
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
