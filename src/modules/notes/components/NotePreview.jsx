import { useMemo, useState } from 'react'
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
  // Click opens the original in a new tab for full-resolution viewing.
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block my-2"
    >
      <img
        src={url}
        alt=""
        className="block w-full h-auto rounded-lg"
        onError={() => setFailed(true)}
      />
    </a>
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
        src={`https://www.youtube-nocookie.com/embed/${videoId}`}
        title="YouTube video"
        className="w-full h-full rounded-lg"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        sandbox="allow-scripts allow-same-origin allow-presentation"
      />
    </div>
  )
}

// ─── Main Preview ────────────────────────────────────────────────────────────

export default function NotePreview({ content, zapSplits, authorPubkey, compactSplits = false }) {
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

      {/* Zap splits */}
      <ZapSplitDisplay zapSplits={zapSplits} compact={compactSplits} />
    </div>
  )
}
