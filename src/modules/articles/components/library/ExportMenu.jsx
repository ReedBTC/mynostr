import { useState } from 'react'
import JSZip from 'jszip'
import { getNDK } from '../../../../lib/ndk.js'
import { buildEpubBlob, exportChapterizedEpub, exportChapterizedMd } from '../../../../lib/epub.js'
import { fetchProfiles } from '../../../../lib/primal.js'
import { titleToSlug } from '../../../../lib/utils.js'
import { useOwnerContext } from '../../../../lib/ownerContext.jsx'
import ExportCustomizationModal from './ExportCustomizationModal.jsx'

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
    // pubkey + dTag pulled from the event when available, falling back
    // to parsing the cached aTag — needed for the credits-page naddr
    // / Primal / zap.cooking link generation in chapterized exports.
    const aTagParts = (meta.aTag || '').split(':')
    out.push({
      content:  event?.content || '',
      author:   meta.author || '',
      metadata: buildMeta(event, meta),
      pubkey:   event?.pubkey || aTagParts[1] || '',
      dTag:     event?.tags?.find(t => t[0] === 'd')?.[1] || aTagParts.slice(2).join(':') || '',
    })
  }
  // Profile enrichment — batch-fetch unique pubkeys to populate lud16
  // for the per-chapter zap-QR. One Primal user_infos call covers
  // every author at once. Failures or missing lud16 → that chapter's
  // QR is just skipped, not a blocker.
  const uniquePubkeys = [...new Set(out.map(c => c.pubkey).filter(Boolean))]
  if (uniquePubkeys.length > 0) {
    try {
      const profileMap = await fetchProfiles(uniquePubkeys)
      for (const ch of out) {
        const p = profileMap.get(ch.pubkey)
        ch.lud16 = p?.lud16 || p?.lud06 || ''
      }
    } catch {
      // Non-fatal — proceed without QRs.
    }
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
  // Customization modal state — open with the pre-selected format so the
  // user lands on the radio they came from, free to switch inside.
  const [modalFormat, setModalFormat] = useState(null) // null | 'epub' | 'md'
  const { sessionUser } = useOwnerContext()

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

  // ── Combined exports go through the customization modal ─────────────
  // Separate-files exports (zip of per-article epubs/mds) skip the
  // modal — there's no collection metadata to customize when the user
  // wants individual files.

  function openCombinedModal(format) {
    setPending(null)
    setError('')
    setModalFormat(format)
  }

  // Modal-driven combined export. Errors propagate to the modal's
  // banner; modal closes itself on success. Throwing here is what
  // makes the modal stay open with an error rather than dismiss
  // silently — important for CORS-blocked cover URLs.
  async function handleModalExport({ format, options }) {
    setStatus('fetching')
    setError('')
    try {
      const articles = await resolveArticles(selectedArticles, setStatus)
      if (format === 'md') {
        exportChapterizedMd(articles, options)
      } else {
        await exportChapterizedEpub(articles, options)
      }
      setStatus('done')
      setModalFormat(null)
    } catch (e) {
      setStatus('')
      throw e
    }
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

      {/* Two-tier export controls — top tier picks the bundling
          mode, second tier (Individually only) picks the format.
          Combined goes straight to the customization modal where
          the user picks format + edits collection metadata. */}
      {pending === 'individually' ? (
        <>
          <span className="text-xs text-neutral-500">Format:</span>
          <button
            onClick={handleMdSeparate}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
          >
            .md
          </button>
          <button
            onClick={handleEpubSeparate}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
          >
            .epub
          </button>
          <button onClick={() => setPending(null)} className="text-xs text-neutral-600 hover:text-neutral-400">✕</button>
        </>
      ) : (
        <>
          <button
            onClick={() => { setStatus(''); setPending('individually') }}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 disabled:opacity-40 transition-colors"
          >
            Individually
          </button>
          <button
            onClick={() => openCombinedModal('epub')}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded border border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600 disabled:opacity-40 transition-colors"
          >
            Combined…
          </button>
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

      <ExportCustomizationModal
        open={!!modalFormat}
        onClose={() => setModalFormat(null)}
        onExport={handleModalExport}
        defaultTitle={listTitle}
        defaultArticleCount={count}
        defaultFormat={modalFormat || 'epub'}
        sessionUser={sessionUser}
      />
    </div>
  )
}
