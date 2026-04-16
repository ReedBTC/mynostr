/**
 * Mirror overlay for the editor textarea.
 * Renders identical text with @mentions highlighted in purple,
 * everything else in normal text color. The textarea text is
 * transparent so this overlay provides all visible text.
 * Must have identical font, padding, and sizing as the textarea.
 */
export default function EditorMirror({ content, mentionNames }) {
  if (!content) return null

  // No mentions tracked — render plain text
  if (mentionNames.length === 0) {
    return (
      <div
        className="absolute inset-0 p-3 text-[15px] leading-relaxed pointer-events-none overflow-hidden whitespace-pre-wrap break-words border border-transparent rounded-lg font-sans text-neutral-100"
        aria-hidden="true"
      >
        {content}
      </div>
    )
  }

  // Build a regex that matches any known @DisplayName
  const escaped = mentionNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`@(${escaped.join('|')})(?=\\s|$|[.,!?;:])`, 'g')

  const parts = []
  let cursor = 0
  for (const m of content.matchAll(re)) {
    if (m.index > cursor) {
      parts.push(<span key={cursor} className="text-neutral-100">{content.slice(cursor, m.index)}</span>)
    }
    parts.push(<span key={m.index} className="text-purple-400 font-medium">{m[0]}</span>)
    cursor = m.index + m[0].length
  }
  if (cursor < content.length) {
    parts.push(<span key={cursor} className="text-neutral-100">{content.slice(cursor)}</span>)
  }

  return (
    <div
      className="absolute inset-0 p-3 text-[15px] leading-relaxed pointer-events-none overflow-hidden whitespace-pre-wrap break-words border border-transparent rounded-lg font-sans"
      aria-hidden="true"
    >
      {parts}
    </div>
  )
}
