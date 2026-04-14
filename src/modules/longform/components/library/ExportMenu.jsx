import { useState } from 'react'
import JSZip from 'jszip'
import { getNDK } from '../../../../lib/ndk.js'
import { buildEpubBlob, exportChapterizedEpub, exportChapterizedMd } from '../../../../lib/epub.js'
import { titleToSlug } from '../../../../lib/utils.js'

/**
 * Fetches the full kind 30023 event content from relays for a given aTag.
 * aTag format: "30023:pubkey:d-tag"
 */
async function fetchArticleContent(aTag) {
  const parts  = aTag.split(':')
  const pubkey = parts[1]
  const dTag   = parts.slice(2).join(':')
  if (!pubkey || !dTag) return null
  try {
    const ndk    = getNDK()
    const events = await ndk.fetchEvents({ kinds: [30023], authors: [pubkey], '#d': [dTag] })
    return Array.from(events)[0] || null
  } catch {
    return null
  }
}

function buildMeta(event, cached) {
  const getTag = name => event?.tags?.find(t => t[0] === name)?.[1] || ''
  return {
    title:           getTag('title')   || cached.title || 'Untitled',
    summary:         getTag('summary') || '',
    image:           getTag('image')   || cached.image || '',
    publishedAtDate: event?.created_at
      ? new Date(event.created_at * 1000).toISOString().split('T')[0]
      : '',
    tags: event?.tags?.filter(t => t[0] === 't').map(t => t[1]) || [],
  }
}

async function resolveArticles(selectedArticles, onStatus) {
  onStatus('fetching')
  const out = []
  for (const meta of selectedArticles) {
    const event = await fetchArticleContent(meta.aTag)
    out.push({
      content:  event?.content || '',
      author:   meta.author || '',
      metadata: buildMeta(event, meta),
    })
  }
  return out
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href    = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function ExportMenu({ selectedArticles, listTitle, onClearSelection }) {
  // 'epub' | 'md' | null — which format is pending a format choice
  const [pending, setPending] = useState(null)
  const [status,  setStatus]  = useState('')   // '' | 'fetching' | 'done' | 'error'
  const [error,   setError]   = useState('')

  const count = selectedArticles.length
  if (!count) return null

  const slug = titleToSlug(listTitle) || 'articles'

  async function run(fn) {
    setPending(null)
    setError('')
    try {
      const articles = await resolveArticles(selectedArticles, setStatus)
      await fn(articles)
      setStatus('done')
    } catch (e) {
      setStatus('error')
      setError(e.message || 'Export failed')
    }
  }

  // ── EPUB handlers ────────────────────────────────────────────────────────────

  async function handleEpubCombined() {
    await run(async articles => {
      await exportChapterizedEpub(articles, listTitle)
    })
  }

  async function handleEpubSeparate() {
    await run(async articles => {
      const zip = new JSZip()
      for (let i = 0; i < articles.length; i++) {
        const a    = articles[i]
        const blob = await buildEpubBlob(a.content, a.metadata, null, a.author, '')
        const name = titleToSlug(a.metadata.title) || `article-${i + 1}`
        zip.file(name + '.epub', blob)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      triggerDownload(blob, slug + '-epubs.zip')
    })
  }

  // ── Markdown handlers ─────────────────────────────────────────────────────────

  async function handleMdCombined() {
    await run(articles => {
      exportChapterizedMd(articles, listTitle)
    })
  }

  async function handleMdSeparate() {
    await run(async articles => {
      const zip = new JSZip()
      for (let i = 0; i < articles.length; i++) {
        const a    = articles[i]
        const title = a.metadata.title || `article-${i + 1}`
        const name  = titleToSlug(title) || `article-${i + 1}`
        const front = ['---', `title: ${title}`, a.author ? `author: ${a.author}` : null,
          a.metadata.publishedAtDate ? `date: ${a.metadata.publishedAtDate}` : null,
          '---', '', ''].filter(l => l !== null).join('\n')
        zip.file(name + '.md', front + a.content)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      triggerDownload(blob, slug + '-articles.zip')
    })
  }

  const busy = status === 'fetching'

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-neutral-900 border-b border-neutral-800 flex-shrink-0 flex-wrap">
      <span className="text-xs text-neutral-400">{count} selected</span>

      {/* Normal state — show .md and .epub buttons */}
      {!pending && (
        <>
          <button
            onClick={() => { setStatus(''); setPending('md') }}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 disabled:opacity-40 transition-colors"
          >
            .md
          </button>
          <button
            onClick={() => { setStatus(''); setPending('epub') }}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 disabled:opacity-40 transition-colors"
          >
            .epub
          </button>
        </>
      )}

      {/* Format choice — .md */}
      {pending === 'md' && (
        <>
          <span className="text-xs text-neutral-500">Format:</span>
          <button
            onClick={handleMdSeparate}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
          >
            Separate files (.zip)
          </button>
          <button
            onClick={handleMdCombined}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600 disabled:opacity-40 transition-colors"
          >
            One combined .md
          </button>
          <button onClick={() => setPending(null)} className="text-xs text-neutral-600 hover:text-neutral-400">✕</button>
        </>
      )}

      {/* Format choice — .epub */}
      {pending === 'epub' && (
        <>
          <span className="text-xs text-neutral-500">Format:</span>
          <button
            onClick={handleEpubSeparate}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
          >
            Separate files (.zip)
          </button>
          <button
            onClick={handleEpubCombined}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600 disabled:opacity-40 transition-colors"
          >
            One combined .epub
          </button>
          <button onClick={() => setPending(null)} className="text-xs text-neutral-600 hover:text-neutral-400">✕</button>
        </>
      )}

      {/* Status */}
      {busy && (
        <span className="text-xs text-neutral-500 flex items-center gap-1.5">
          <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
          Fetching…
        </span>
      )}
      {status === 'done'  && <span className="text-xs text-green-500">✓ exported</span>}
      {status === 'error' && <span className="text-xs text-red-400">{error}</span>}

      <button
        onClick={onClearSelection}
        className="ml-auto text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
      >
        clear
      </button>
    </div>
  )
}
