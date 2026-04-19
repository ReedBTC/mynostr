import { useEffect, useMemo, useState } from 'react'
import { isSafeUrl } from '../../../lib/utils.js'
import { parseNoteContent } from '../../../lib/noteParser.js'
import { MentionChip, EmbeddedNoteCard } from './EntityCard.jsx'
import LinkPreview from './LinkPreview.jsx'
import ZapSplitDisplay from './ZapSplitDisplay.jsx'

// ─── Segment renderers ───────────────────────────────────────────────────────

function TextSegment({ value }) {
  // Preserve newlines
  return <span className="whitespace-pre-wrap break-words">{value}</span>
}

function HashtagSegment({ value, tag }) {
  return (
    <span className="text-purple-400 font-medium cursor-default">{value}</span>
  )
}

function ImageSegment({ url }) {
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)

  // Esc closes. Also lock background scroll while the lightbox is up.
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  if (failed || !isSafeUrl(url)) {
    return (
      <div className="my-2">
        <a href={isSafeUrl(url) ? url : '#'} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline break-all text-sm">
          {url}
        </a>
      </div>
    )
  }

  // Full card width, natural aspect ratio — matches Damus/Primal.
  // Click opens an in-app fullscreen lightbox (closable with the ✕ button,
  // a backdrop click, or Esc).
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block my-2 w-full cursor-zoom-in"
        aria-label="Open image"
      >
        <img
          src={url}
          alt=""
          className="block w-full h-auto rounded-lg"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-4"
          onClick={e => { e.stopPropagation(); setOpen(false) }}
        >
          <button
            type="button"
            onClick={e => { e.stopPropagation(); setOpen(false) }}
            aria-label="Close image"
            className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 text-neutral-100 text-xl leading-none flex items-center justify-center border border-neutral-700"
          >
            ✕
          </button>
          <img
            src={url}
            alt=""
            onClick={e => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </>
  )
}

function VideoSegment({ url }) {
  if (!isSafeUrl(url)) return <span className="text-neutral-500 text-sm break-all">{url}</span>
  return (
    <div className="my-2">
      <video
        src={url}
        controls
        className="block w-full h-auto rounded-lg"
        preload="metadata"
      />
    </div>
  )
}

function YouTubeSegment({ videoId, url }) {
  return (
    <div className="my-1.5 aspect-video">
      <iframe
        src={`https://www.youtube.com/embed/${videoId}`}
        title="YouTube video"
        className="w-full h-full rounded-lg"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  )
}

// ─── Main Preview ────────────────────────────────────────────────────────────

// `showZapSplits` is opt-in (default off). Feed contexts (NoteCard) don't
// set it — surfacing splits there implies "the zap ⚡ button will honor this
// distribution," which our ZapModal can't do yet (no NWC, one bolt11 per
// zap). The composer's write-preview opts in so authors can still see how
// their split tags will render to readers once that lands.
export default function NotePreview({ content, zapSplits, authorPubkey, compactSplits = false, showZapSplits = false }) {
  const segments = useMemo(() => parseNoteContent(content), [content])

  return (
    <div className="flex flex-col gap-1">
      {/* Note content */}
      <div className="text-[15px] text-neutral-200 leading-relaxed font-sans">
        {segments.map((seg, i) => {
          switch (seg.type) {
            case 'text':
              return <TextSegment key={i} value={seg.value} />
            case 'mention':
              // Extract the nip19 string (strip "nostr:" prefix)
              return <MentionChip key={i} nip19Str={seg.value.replace('nostr:', '')} />
            case 'note_embed':
              return <EmbeddedNoteCard key={i} nip19Str={seg.value.replace('nostr:', '')} />
            case 'hashtag':
              return <HashtagSegment key={i} value={seg.value} tag={seg.data?.tag} />
            case 'image':
              return <ImageSegment key={i} url={seg.data.url || seg.value} />
            case 'video':
              return <VideoSegment key={i} url={seg.data.url || seg.value} />
            case 'youtube':
              return <YouTubeSegment key={i} videoId={seg.data.videoId} url={seg.value} />
            case 'link':
              return <LinkPreview key={i} url={seg.data.url || seg.value} />
            default:
              return <span key={i}>{seg.value}</span>
          }
        })}
      </div>

      {showZapSplits && Array.isArray(zapSplits) && zapSplits.length > 0 && (
        <ZapSplitDisplay zapSplits={zapSplits} compact={compactSplits} />
      )}
    </div>
  )
}
