import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import { isSafeUrl, parseDateString } from '../../../lib/utils.js'

/**
 * Read-only rendering of the current draft — what the published article will
 * look like. Shown when the Write/Preview toggle is flipped to Preview.
 * rehypeSanitize blocks any XSS smuggled in through the markdown source.
 */
export default function EditorPreview({
  content,
  metadata,
  source,
  wordCount,
  readTime,
  coverBroken,
  onCoverBroken,
}) {
  return (
    <div className="flex-1 overflow-y-auto bg-neutral-950 px-4 sm:px-8 py-6">
      {wordCount > 0 && (
        <p className="text-xs text-neutral-600 text-right mb-4">
          {wordCount.toLocaleString()} words · {readTime} min read
        </p>
      )}

      {metadata?.image && isSafeUrl(metadata.image) && !coverBroken && (
        <div className="w-full aspect-video mb-6 rounded-lg overflow-hidden border border-neutral-800">
          <img
            src={metadata.image}
            alt="Cover"
            className="w-full h-full object-cover"
            onError={onCoverBroken}
          />
        </div>
      )}

      {metadata?.title && (
        <h1 className="text-2xl font-bold text-neutral-100 leading-tight mb-2 font-sans">
          {metadata.title}
        </h1>
      )}

      {metadata?.summary && (
        <p className="text-base text-neutral-400 leading-relaxed mb-3 font-sans">
          {metadata.summary}
        </p>
      )}

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

      {(metadata?.title || metadata?.summary || source?.name) && (
        <hr className="border-neutral-800 mb-6" />
      )}

      <div className="prose prose-invert prose-sm max-w-none font-sans">
        <MDEditor.Markdown
          source={content}
          style={{ backgroundColor: 'transparent', color: 'inherit' }}
          rehypePlugins={[rehypeSanitize]}
        />
      </div>
    </div>
  )
}
