import { useRef, useState, useEffect } from 'react'
import MDEditor, { commands } from '@uiw/react-md-editor'
import { isSafeUrl, parseDateString, parseFrontmatter, buildFrontmatter, titleToSlug } from '../lib/utils.js'
import { uploadToBlossom } from '../lib/blossom.js'
import { exportEpub } from '../lib/epub.js'

export default function Editor({ content, onChange, activeTab, onTabChange, metadata, source, onClear, onFileLoad, readOnly, user, naddr }) {
  const fileInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const [clearPending, setClearPending] = useState(false)
  const [epubExporting, setEpubExporting] = useState(false)
  const [epubError, setEpubError] = useState('')
  const clearTimerRef = useRef(null)
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState('')
  const contentRef = useRef(content)
  contentRef.current = content
  const uploadingRef = useRef(false)

  // Auto-cancel the confirm state after 3 seconds if user doesn't follow through
  useEffect(() => {
    if (clearPending) {
      clearTimerRef.current = setTimeout(() => setClearPending(false), 3000)
    }
    return () => clearTimeout(clearTimerRef.current)
  }, [clearPending])

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
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const raw = ev.target.result || ''
      e.target.value = ''

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
      const textarea = document.querySelector('.w-md-editor-text-input')
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
      setImageError(err.message || 'Image upload failed.')
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
    const filename = (titleToSlug(metadata.title) || 'nostrmd-export') + '.md'
    const blob = new Blob([fullContent], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleEpubExport() {
    if (epubExporting) return
    setEpubExporting(true)
    setEpubError('')
    try {
      const author = user?.profile?.displayName || user?.profile?.name || ''
      await exportEpub(content, metadata, source, author, naddr)
    } catch (err) {
      console.error('epub export failed:', err)
      setEpubError(err.message || 'Export failed.')
      setTimeout(() => setEpubError(''), 5000)
    } finally {
      setEpubExporting(false)
    }
  }

  return (
    <div className="flex flex-col h-full" data-color-mode="dark">
      {/* Tab switcher */}
      <div className="flex items-center gap-1 px-4 pt-4 pb-2 border-b border-neutral-800">
        <button
          onClick={() => { onTabChange('upload'); fileInputRef.current?.click() }}
          disabled={readOnly}
          className={`px-4 py-1.5 rounded text-sm transition-colors ${
            readOnly
              ? 'text-neutral-700 cursor-not-allowed'
              : activeTab === 'upload'
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
          }`}
          aria-pressed={activeTab === 'upload'}
        >
          Upload .md file
        </button>
        <button
          onClick={() => onTabChange('write')}
          disabled={readOnly}
          className={`px-4 py-1.5 rounded text-sm transition-colors ${
            readOnly
              ? 'text-neutral-700 cursor-not-allowed'
              : activeTab === 'write'
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
          }`}
          aria-pressed={activeTab === 'write'}
        >
          Write / Paste
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          onChange={handleFileUpload}
          className="hidden"
          aria-hidden="true"
        />

        {/* Export always shown in read-only when there's content; Clear hidden in read-only */}
        {(content || metadata?.title) && (
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={handleExport}
              className="px-3 py-1.5 text-sm rounded border border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-500 transition-colors"
              aria-label="Export as markdown file with frontmatter"
            >
              Export .md
            </button>
            <button
              onClick={handleEpubExport}
              disabled={epubExporting}
              className="px-3 py-1.5 text-sm rounded border border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Export as epub for ereaders"
            >
              {epubExporting ? 'Exporting…' : 'Export .epub'}
            </button>
            {epubError && (
              <span className="text-xs text-red-400 ml-1">{epubError}</span>
            )}
            {!readOnly && (
              <button
                onClick={handleClearClick}
                className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                  clearPending
                    ? 'border-red-800 text-red-400 hover:bg-red-950'
                    : 'border-neutral-700 text-neutral-500 hover:text-red-400 hover:border-red-900'
                }`}
                aria-label={clearPending ? 'Confirm clear' : 'Clear editor and reset all fields'}
              >
                {clearPending ? 'Sure?' : 'Clear'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Editor + preview split */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: raw markdown editor, no built-in preview */}
        <div
          className={`w-1/2 overflow-hidden border-r border-neutral-800 relative ${readOnly ? 'pointer-events-none opacity-40' : ''}`}
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
          {/* Hidden file input for toolbar image button */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; insertImageFromFile(f) }}
            className="hidden"
            aria-hidden="true"
          />
          {/* Upload status overlay */}
          {(imageUploading || imageError) && (
            <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded text-xs ${
              imageError ? 'bg-red-950 border border-red-800 text-red-400' : 'bg-neutral-800 text-neutral-300'
            }`}>
              {imageError || 'Uploading image…'}
            </div>
          )}
        </div>

        {/* Right: custom preview with metadata header */}
        <div className="w-1/2 overflow-y-auto bg-neutral-950 px-8 py-6">

          {/* Word count + read time */}
          {wordCount > 0 && (
            <p className="text-xs text-neutral-600 text-right mb-4">
              {wordCount.toLocaleString()} words · {readTime} min read
            </p>
          )}

          {/* Cover image — 16:9, only render if URL uses http/https */}
          {metadata?.image && isSafeUrl(metadata.image) && (
            <div className="w-full aspect-video mb-6 rounded-lg overflow-hidden border border-neutral-800">
              <img
                src={metadata.image}
                alt="Cover"
                className="w-full h-full object-cover"
                onError={e => { e.target.parentElement.style.display = 'none' }}
              />
            </div>
          )}

          {/* Title */}
          {metadata?.title && (
            <h1 className="text-2xl font-bold text-neutral-100 leading-tight mb-2 font-sans">
              {metadata.title}
            </h1>
          )}

          {/* Subtitle / summary */}
          {metadata?.summary && (
            <p className="text-base text-neutral-400 leading-relaxed mb-3 font-sans">
              {metadata.summary}
            </p>
          )}

          {/* Attribution line — rendered as JSX so the link is a real hyperlink */}
          {source?.name && (
            <p className="text-sm text-neutral-500 italic mb-4 font-sans">
              Originally published at{' '}
              {source.url && isSafeUrl(source.url)
                ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-300">{source.name}</a>
                : source.name
              }
              {metadata?.publishedAtDate && (
                <> on {parseDateString(metadata.publishedAtDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</>
              )}
            </p>
          )}

          {/* Divider between header and body */}
          {(metadata?.title || metadata?.summary || source?.name) && (
            <hr className="border-neutral-800 mb-6" />
          )}

          {/* Rendered markdown body */}
          <div className="prose prose-invert prose-sm max-w-none font-sans">
            <MDEditor.Markdown
              source={content}
              style={{ backgroundColor: 'transparent', color: 'inherit' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
