import { useRef, useState, useEffect } from 'react'
import MDEditor, { commands } from '@uiw/react-md-editor'
import { nip19 } from 'nostr-tools'
import { parseFrontmatter, buildFrontmatter, titleToSlug, getPublishedAtDate, withTimeout } from '../../../lib/utils.js'
import { uploadToBlossom } from '../../../lib/blossom.js'
import { exportEpub } from '../../../lib/epub.js'
import { getNDK, connectAndWait } from '../../../lib/ndk.js'
import { useIsMobile } from '../../../hooks/useIsMobile.js'
import EditorPreview from './EditorPreview.jsx'

const MAX_MD_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB — generous for long articles, guards against accidental large file drops

export default function Editor({ content, onChange, metadata, source, onClear, onFileLoad, readOnly, user, naddr, onOpenDraftDrawer, onToggleMetadata, metadataOpen, metadataButtonRef }) {
  const fileInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const [clearPending, setClearPending] = useState(false)
  const [epubExporting, setEpubExporting] = useState(false)
  const [epubError, setEpubError] = useState('')
  const clearTimerRef = useRef(null)
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState('')
  const [naddrInput, setNaddrInput] = useState('')
  const [naddrError, setNaddrError] = useState('')
  const [naddrLoading, setNaddrLoading] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const [coverBroken, setCoverBroken] = useState(false)
  const [fileError, setFileError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef(null)
  const menuPanelRef  = useRef(null)
  const [exportOpen, setExportOpen] = useState(false)
  const exportButtonRef = useRef(null)
  const exportPanelRef  = useRef(null)
  const isMobile = useIsMobile()
  const contentRef = useRef(content)
  contentRef.current = content
  const uploadingRef = useRef(false)
  // Scopes the image-insert cursor lookup to this editor's DOM subtree so we
  // don't accidentally pick up a textarea from another MDEditor mounted
  // elsewhere in the tree.
  const editorWrapperRef = useRef(null)

  // Auto-cancel the confirm state after 3 seconds if user doesn't follow through
  useEffect(() => {
    if (clearPending) {
      clearTimerRef.current = setTimeout(() => setClearPending(false), 3000)
    }
    return () => clearTimeout(clearTimerRef.current)
  }, [clearPending])

  // Re-show the cover image when the URL changes (load article → swap cover).
  useEffect(() => { setCoverBroken(false) }, [metadata?.image])

  // Mobile overflow menu: close when the viewport widens back to desktop or
  // when the user clicks outside the trigger/panel.
  useEffect(() => { if (!isMobile) setMenuOpen(false) }, [isMobile])
  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e) {
      if (menuButtonRef.current?.contains(e.target)) return
      if (menuPanelRef.current?.contains(e.target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  // Desktop Export dropdown — same outside-click pattern as the mobile menu.
  useEffect(() => {
    if (!exportOpen) return
    function handleClick(e) {
      if (exportButtonRef.current?.contains(e.target)) return
      if (exportPanelRef.current?.contains(e.target)) return
      setExportOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [exportOpen])

  function handleClearClick() {
    if (!clearPending) { setClearPending(true); return }
    setClearPending(false)
    onClear()
  }

  // Word count and read time (avg 200 wpm)
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0
  const readTime = Math.ceil(wordCount / 200)

  function handleFileUpload(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_MD_UPLOAD_BYTES) {
      setFileError('File too large — 5 MB max.')
      setTimeout(() => setFileError(''), 5000)
      return
    }
    const reader = new FileReader()
    reader.onerror = () => {
      setFileError('Could not read file.')
      setTimeout(() => setFileError(''), 5000)
    }
    reader.onload = (ev) => {
      const raw = ev.target.result || ''

      const { frontmatter, content: body } = parseFrontmatter(raw)

      // If no frontmatter, just load the raw content as before
      if (!frontmatter) { onChange(body); return }

      // Frontmatter found — populate metadata and source fields
      const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : []
      onFileLoad({
        content: body,
        metadata: {
          title:          frontmatter.title || '',
          summary:        frontmatter.summary || '',
          publishedAtDate: frontmatter.published_at || '',
          image:          frontmatter.image || '',
          tagsRaw:        tags.join(', '),
          tags,
        },
        source: {
          name: frontmatter.source_name || '',
          url:  frontmatter.source_url  || '',
        },
      })
    }
    reader.readAsText(file)
  }

  // Uploads an image file, inserts ![](url) at the current cursor position
  async function insertImageFromFile(file) {
    if (!file || !file.type.startsWith('image/')) return
    if (uploadingRef.current) return
    uploadingRef.current = true
    setImageUploading(true)
    setImageError('')
    try {
      const url = await uploadToBlossom(file)
      const insertion = `![](${url})`
      // Read latest content via ref to avoid stale closure
      const current = contentRef.current
      // `.w-md-editor-text-input` is an internal class on @uiw/react-md-editor's
      // <textarea>. Selecting it directly lets us insert at the current cursor
      // rather than appending at the end. Scoped to this editor's wrapper so
      // a second MDEditor elsewhere can't hijack the match. If a library
      // upgrade renames the class, we silently fall back to append-at-end.
      const textarea = editorWrapperRef.current?.querySelector('.w-md-editor-text-input')
      if (textarea) {
        const start = textarea.selectionStart ?? current.length
        const end = textarea.selectionEnd ?? current.length
        const before = current.slice(0, start)
        const after = current.slice(end)
        const needsNewline = before.length > 0 && !before.endsWith('\n')
        onChange((needsNewline ? before + '\n' : before) + insertion + after)
      } else {
        onChange(current + (current.endsWith('\n') || !current ? '' : '\n') + insertion)
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('image upload failed:', err)
      setImageError('Image upload failed.')
      setTimeout(() => setImageError(''), 5000)
    } finally {
      setImageUploading(false)
      uploadingRef.current = false
    }
  }

  // Custom toolbar image command — opens file picker instead of inserting template
  const imageUploadCommand = {
    ...commands.image,
    execute: () => { imageInputRef.current?.click() },
  }

  function handleEditorDrop(e) {
    const file = Array.from(e.dataTransfer?.files || []).find(f => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    insertImageFromFile(file)
  }

  function handleEditorPaste(e) {
    const file = Array.from(e.clipboardData?.files || []).find(f => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    insertImageFromFile(file)
  }

  function handleExport() {
    const frontmatter = buildFrontmatter(metadata, source)
    const fullContent = frontmatter + content
    const filename = (titleToSlug(metadata.title) || 'mynostr-export') + '.md'
    const blob = new Blob([fullContent], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleNaddrLoad() {
    const trimmed = naddrInput.trim()
    if (!trimmed) return
    setNaddrError('')

    let decoded
    try { decoded = nip19.decode(trimmed) } catch { decoded = null }
    if (!decoded) { setNaddrError('Paste a valid naddr.'); return }
    if (decoded.type !== 'naddr' || decoded.data.kind !== 30023) {
      setNaddrError('Only long-form notes can be edited here.')
      return
    }

    setNaddrLoading(true)
    try {
      const ndk = getNDK()
      await connectAndWait(ndk, 3000).catch(() => {})
      const events = await withTimeout(
        ndk.fetchEvents({
          kinds: [30023],
          authors: [decoded.data.pubkey],
          '#d': [decoded.data.identifier],
        }),
        8000,
        'fetch-timeout'
      )
      const ev = Array.from(events)[0]
      if (!ev) { setNaddrError('Article not found on relays.'); return }

      const getTag = n => ev.tags?.find(t => t[0] === n)?.[1] || ''
      const tags = ev.tags?.filter(t => t[0] === 't').map(t => t[1]) || []

      onFileLoad({
        content: ev.content || '',
        metadata: {
          title:          getTag('title'),
          summary:        getTag('summary'),
          publishedAtDate: getPublishedAtDate(ev),
          image:          getTag('image'),
          tagsRaw:        tags.join(', '),
          tags,
        },
        naddr: trimmed,
      })
      setNaddrInput('')
    } catch (err) {
      if (import.meta.env.DEV) console.error('naddr load failed:', err)
      setNaddrError(err?.message === 'fetch-timeout' ? 'Relays timed out.' : 'Load failed.')
    } finally {
      setNaddrLoading(false)
    }
  }

  async function handleEpubExport() {
    if (epubExporting) return
    setEpubExporting(true)
    setEpubError('')
    try {
      const author = user?.profile?.displayName || user?.profile?.name || ''
      await exportEpub(content, metadata, source, author, naddr)
    } catch (err) {
      if (import.meta.env.DEV) console.error('epub export failed:', err)
      setEpubError('Export failed.')
      setTimeout(() => setEpubError(''), 5000)
    } finally {
      setEpubExporting(false)
    }
  }

  const toggleBtn = (active, label, onClick) => (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs rounded transition-colors ${
        active
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-500 hover:text-neutral-300'
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  )

  return (
    <div className="flex flex-col h-full flex-1 min-w-0" data-color-mode="dark">
      {/* Toolbar — matches editor column width so the Metadata drawer can sit
          beside it without covering buttons. */}
      <div className="border-b border-neutral-800 flex-shrink-0 relative">
        <div className="w-full max-w-4xl mx-auto px-4 pt-4 pb-2 flex items-center gap-1">
          {isMobile ? (
            <button
              ref={menuButtonRef}
              onClick={() => setMenuOpen(o => !o)}
              aria-label="Toolbar actions"
              aria-expanded={menuOpen}
              className="p-1.5 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
            </button>
          ) : (
            <>
              {/* Order: Upload → naddr → Drafts → Clear → Export → Write/Preview → Publishing Details */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={readOnly}
                className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                  readOnly
                    ? 'border-neutral-800 text-neutral-700 cursor-not-allowed'
                    : 'border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-500'
                }`}
              >
                Upload .md
              </button>
              {fileError && (
                <span className="text-xs text-red-400 ml-1">{fileError}</span>
              )}
              <form
                onSubmit={e => { e.preventDefault(); handleNaddrLoad() }}
                className="flex items-center gap-1"
              >
                <input
                  type="text"
                  value={naddrInput}
                  onChange={e => { setNaddrInput(e.target.value); if (naddrError) setNaddrError('') }}
                  placeholder="Paste article naddr…"
                  disabled={readOnly || naddrLoading}
                  className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 w-36 disabled:opacity-40"
                />
                <button
                  type="submit"
                  disabled={readOnly || naddrLoading || !naddrInput.trim()}
                  className="px-2.5 py-1 text-xs rounded border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {naddrLoading ? '…' : 'Load'}
                </button>
                {naddrError && (
                  <span className="text-xs text-red-400 ml-1">{naddrError}</span>
                )}
              </form>
              <button
                onClick={onOpenDraftDrawer}
                disabled={readOnly || !onOpenDraftDrawer}
                className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                  readOnly || !onOpenDraftDrawer
                    ? 'border-neutral-800 text-neutral-700 cursor-not-allowed'
                    : 'border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-500'
                }`}
              >
                My Drafts
              </button>
              {(() => {
                const clearEnabled = !readOnly && !!(content || metadata?.title)
                return (
                  <button
                    onClick={handleClearClick}
                    disabled={!clearEnabled}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      !clearEnabled
                        ? 'border-neutral-800 text-neutral-700 cursor-not-allowed'
                        : clearPending
                          ? 'border-red-800 text-red-400 hover:bg-red-950'
                          : 'border-neutral-700 text-neutral-500 hover:text-red-400 hover:border-red-900'
                    }`}
                    aria-label={clearPending ? 'Confirm clear' : 'Clear editor and reset all fields'}
                  >
                    {clearPending ? 'Sure?' : 'Clear'}
                  </button>
                )
              })()}
              {(() => {
                const exportEnabled = !!(content || metadata?.title)
                return (
                  <div className="relative">
                    <button
                      ref={exportButtonRef}
                      onClick={() => setExportOpen(o => !o)}
                      disabled={!exportEnabled}
                      aria-haspopup="menu"
                      aria-expanded={exportOpen}
                      className={`px-2.5 py-1 text-xs rounded border transition-colors flex items-center gap-1 ${
                        !exportEnabled
                          ? 'border-neutral-800 text-neutral-700 cursor-not-allowed'
                          : 'border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-500'
                      }`}
                    >
                      Export <span className="text-[10px] leading-none">▾</span>
                    </button>
                    {exportOpen && exportEnabled && (
                      <div
                        ref={exportPanelRef}
                        role="menu"
                        className="absolute left-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 min-w-[160px] py-1"
                      >
                        <button
                          role="menuitem"
                          onClick={() => { setExportOpen(false); handleExport() }}
                          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
                        >
                          Markdown (.md)
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => { setExportOpen(false); handleEpubExport() }}
                          disabled={epubExporting}
                          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {epubExporting ? 'Exporting…' : 'EPUB (.epub)'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })()}
              {epubError && (
                <span className="text-xs text-red-400 ml-1">{epubError}</span>
              )}
            </>
          )}

          {/* Hidden file input — shared between desktop inline button and mobile menu item */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            onChange={handleFileUpload}
            className="hidden"
            aria-hidden="true"
          />

          {/* Right: Write/Preview toggle + Metadata (always visible on both breakpoints) */}
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center bg-neutral-900 border border-neutral-800 rounded p-0.5">
              {toggleBtn(!previewMode, 'Write',   () => setPreviewMode(false))}
              {toggleBtn(previewMode,  'Preview', () => setPreviewMode(true))}
            </div>
            <button
              ref={metadataButtonRef}
              onClick={onToggleMetadata}
              disabled={readOnly || !onToggleMetadata}
              aria-pressed={!!metadataOpen}
              className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                readOnly || !onToggleMetadata
                  ? 'border-neutral-800 text-neutral-700 cursor-not-allowed'
                  : metadataOpen
                    ? 'bg-purple-900/40 border-purple-700 text-purple-200'
                    : 'border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600'
              }`}
            >
              Publishing Details
            </button>
          </div>
        </div>

        {/* Mobile: error banner for actions that fire after the menu closes */}
        {isMobile && (fileError || epubError) && (
          <div className="w-full px-4 pb-2 text-xs text-red-400">
            {fileError || epubError}
          </div>
        )}

        {/* Mobile overflow menu — contains every secondary action collapsed from the top bar */}
        {isMobile && menuOpen && (
          <div
            ref={menuPanelRef}
            className="absolute top-full left-4 z-30 mt-1 bg-neutral-900 border border-neutral-700 rounded shadow-xl min-w-[240px] py-1"
          >
            <button
              onClick={() => { setMenuOpen(false); fileInputRef.current?.click() }}
              disabled={readOnly}
              className={`w-full text-left px-3 py-2.5 text-xs transition-colors ${
                readOnly
                  ? 'text-neutral-700 cursor-not-allowed'
                  : 'text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              Upload .md
            </button>
            <button
              onClick={() => { setMenuOpen(false); onOpenDraftDrawer?.() }}
              disabled={readOnly || !onOpenDraftDrawer}
              className={`w-full text-left px-3 py-2.5 text-xs transition-colors ${
                readOnly || !onOpenDraftDrawer
                  ? 'text-neutral-700 cursor-not-allowed'
                  : 'text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              My Drafts
            </button>
            <div className="border-t border-neutral-800 my-1" />
            <form
              onSubmit={e => { e.preventDefault(); handleNaddrLoad() }}
              className="flex items-center gap-1 px-3 py-2"
            >
              <input
                type="text"
                value={naddrInput}
                onChange={e => { setNaddrInput(e.target.value); if (naddrError) setNaddrError('') }}
                placeholder="Paste naddr…"
                disabled={readOnly || naddrLoading}
                className="flex-1 min-w-0 bg-neutral-950 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 disabled:opacity-40"
              />
              <button
                type="submit"
                disabled={readOnly || naddrLoading || !naddrInput.trim()}
                className="px-2.5 py-1 text-xs rounded border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {naddrLoading ? '…' : 'Load'}
              </button>
            </form>
            {naddrError && (
              <div className="px-3 pb-2 text-xs text-red-400">{naddrError}</div>
            )}
            {(content || metadata?.title) && (
              <>
                <div className="border-t border-neutral-800 my-1" />
                <button
                  onClick={() => { setMenuOpen(false); handleExport() }}
                  className="w-full text-left px-3 py-2.5 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
                >
                  Export .md
                </button>
                <button
                  onClick={() => { setMenuOpen(false); handleEpubExport() }}
                  disabled={epubExporting}
                  className="w-full text-left px-3 py-2.5 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {epubExporting ? 'Exporting…' : 'Export .epub'}
                </button>
              </>
            )}
            {(() => {
              const clearEnabled = !readOnly && !!(content || metadata?.title)
              return (
                <>
                  <div className="border-t border-neutral-800 my-1" />
                  <button
                    onClick={() => {
                      // First click arms "Sure?"; keep menu open so the user can confirm.
                      // Second click (confirming) actually clears — close the menu.
                      if (clearPending) setMenuOpen(false)
                      handleClearClick()
                    }}
                    disabled={!clearEnabled}
                    className={`w-full text-left px-3 py-2.5 text-xs transition-colors ${
                      !clearEnabled
                        ? 'text-neutral-700 cursor-not-allowed'
                        : clearPending
                          ? 'text-red-400 hover:bg-red-950'
                          : 'text-neutral-400 hover:text-red-400 hover:bg-neutral-800'
                    }`}
                  >
                    {clearPending ? 'Confirm clear' : 'Clear'}
                  </button>
                </>
              )
            })()}
          </div>
        )}
      </div>

      {/* Editor / Preview body — centered column, swaps on toggle */}
      <div className="flex-1 overflow-hidden flex justify-center">
        <div className="w-full max-w-4xl flex flex-col relative">
          {!previewMode && (
            <div
              ref={editorWrapperRef}
              className={`flex-1 overflow-hidden relative ${readOnly ? 'pointer-events-none opacity-40' : ''}`}
              onDrop={handleEditorDrop}
              onDragOver={e => e.preventDefault()}
              onPaste={handleEditorPaste}
            >
              <MDEditor
                value={content}
                onChange={val => onChange(val || '')}
                height="100%"
                visibleDragbar={false}
                preview="edit"
                hideToolbar={false}
                className="h-full"
                commands={[
                  commands.bold, commands.italic, commands.strikethrough,
                  commands.hr, commands.title,
                  commands.divider,
                  commands.link, imageUploadCommand,
                  commands.divider,
                  commands.quote, commands.code, commands.codeBlock,
                  commands.divider,
                  commands.unorderedListCommand, commands.orderedListCommand, commands.checkedListCommand,
                ]}
              />
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; insertImageFromFile(f) }}
                className="hidden"
                aria-hidden="true"
              />
              {(imageUploading || imageError) && (
                <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded text-xs ${
                  imageError ? 'bg-red-950 border border-red-800 text-red-400' : 'bg-neutral-800 text-neutral-300'
                }`}>
                  {imageError || 'Uploading image…'}
                </div>
              )}
            </div>
          )}

          {previewMode && (
            <EditorPreview
              content={content}
              metadata={metadata}
              source={source}
              wordCount={wordCount}
              readTime={readTime}
              coverBroken={coverBroken}
              onCoverBroken={() => setCoverBroken(true)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
