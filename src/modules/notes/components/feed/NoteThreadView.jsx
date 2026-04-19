/**
 * NoteThreadView — dedicated screen for viewing a kind 1 note in thread
 * context.
 *
 * Layout:
 *   [← Back]  Thread
 *   ────────────────────────────────────────
 *   [root card]                    (context)
 *   [ancestor₁]                    (chain down to focus)
 *   [ancestor₂]
 *   [FOCUS CARD]                   (purple border)
 *   ├─ [reply]                     (indented subtree)
 *   │   └─ [sub-reply]
 *   └─ [reply]
 *
 * Clicking any card opens a new thread view rooted on that note — the
 * parent tab owns a thread stack so the back button unwinds one level at
 * a time. That's why this component is dumb: it only renders + calls
 * onNoteClick / onBack.
 *
 * Full-chain semantics: when the user opens a mid-thread reply, we walk
 * every ancestor up to the root and show them stacked above the focus.
 * Users should never wonder "what was this replying to?".
 *
 * Auto-scroll: on first data load we scroll the focus card into view so
 * users land oriented instead of at the top of a long ancestor chain.
 */
import { useEffect, useRef } from 'react'
import NoteCard from './NoteCard.jsx'
import { useNoteThread } from '../../../../lib/useNoteThread.js'

// Indent cap — too much and deep threads overflow mobile width.
const MAX_DEPTH = 6
const INDENT_PX = 14

function DescendantTree({ parentId, childrenByParent, profiles, onNoteClick, depth }) {
  // Hard stop — if malformed data somehow creates a reply cycle (A → B → A),
  // the kid lookup loops forever. MAX_DEPTH only caps indent; this caps
  // recursion itself well past any legitimate thread depth.
  if (depth > MAX_DEPTH + 10) return null
  const kids = childrenByParent.get(parentId) || []
  if (kids.length === 0) return null
  const clampedDepth = Math.min(depth, MAX_DEPTH)
  return (
    <ul className="space-y-2">
      {kids.map(k => (
        <li
          key={k.id}
          className={depth > 0 ? 'border-l border-neutral-800 pl-2.5' : ''}
          style={depth > 0 ? { marginLeft: `${clampedDepth * INDENT_PX}px` } : undefined}
        >
          <NoteCard
            note={k}
            profile={profiles.get(k.pubkey)}
            onNoteClick={onNoteClick}
          />
          <div className="mt-2">
            <DescendantTree
              parentId={k.id}
              childrenByParent={childrenByParent}
              profiles={profiles}
              onNoteClick={onNoteClick}
              depth={depth + 1}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function NoteThreadView({ focus, onBack, onNoteClick, initialProfile }) {
  const { loading, error, data } = useNoteThread(focus)
  const focusRef = useRef(null)

  // Scroll focus into view once the thread has loaded. One-shot — further
  // loads within the same focus don't re-jump.
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (!data) { scrolledRef.current = false; return }
    if (scrolledRef.current) return
    scrolledRef.current = true
    // Next tick so the DOM has settled.
    requestAnimationFrame(() => {
      focusRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    })
  }, [data])

  const header = (
    <div className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur border-b border-neutral-800">
      <div className="max-w-2xl mx-auto px-4 py-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
          aria-label="Back"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 12 6 8 10 4" />
          </svg>
          <span>Back</span>
        </button>
        <span className="text-xs text-neutral-300 font-medium">Thread</span>
      </div>
    </div>
  )

  if (loading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        {header}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-10 text-center">
            <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-neutral-500 mt-2">Loading thread…</p>
          </div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    // Degrade gracefully — render the focus alone so the user at least
    // sees the note they clicked on.
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        {header}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-4">
            {error && (
              <p className="text-xs text-red-400 mb-3 text-center">{error}</p>
            )}
            <NoteCard note={focus} profile={initialProfile || null} focused />
            <p className="text-[11px] text-neutral-600 text-center mt-4">
              No replies loaded.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const { root, ancestors, childrenByParent, profiles } = data
  // `ancestors` already goes root → parent-of-focus. If root === focus
  // (top-level note), ancestors is empty. Deduplicate in case the walker
  // included focus somehow.
  const chain = ancestors.filter(n => n.id !== focus.id)
  const rootIsFocus = root.id === focus.id

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {header}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-4 space-y-2">
          {/* Root card — omitted if root === focus or already in ancestors */}
          {!rootIsFocus && !chain.some(a => a.id === root.id) && (
            <NoteCard
              note={root}
              profile={profiles.get(root.pubkey)}
              onNoteClick={onNoteClick}
            />
          )}

          {/* Ancestor chain root → parent of focus */}
          {chain.map(n => (
            <NoteCard
              key={n.id}
              note={n}
              profile={profiles.get(n.pubkey)}
              onNoteClick={onNoteClick}
            />
          ))}

          {/* Focus — highlighted. Use a wrapper div for the scroll target so
              the border style comes from NoteCard's `focused` prop. */}
          <div ref={focusRef} className="scroll-mt-16">
            <NoteCard
              note={focus}
              profile={profiles.get(focus.pubkey) || initialProfile || null}
              focused
            />
          </div>

          {/* Descendants (direct replies to focus, then recurse) */}
          <div className="mt-2">
            <DescendantTree
              parentId={focus.id}
              childrenByParent={childrenByParent}
              profiles={profiles}
              onNoteClick={onNoteClick}
              depth={0}
            />
          </div>

          {!childrenByParent.get(focus.id)?.length && (
            <p className="text-[11px] text-neutral-600 text-center pt-4">
              No replies yet.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
