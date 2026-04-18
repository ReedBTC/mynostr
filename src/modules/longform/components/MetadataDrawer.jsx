import { useEffect, useRef } from 'react'
import MetadataForm from './MetadataForm.jsx'
import OriginalSourceField from './OriginalSourceField.jsx'
import PublishButton from './PublishButton.jsx'
import { formatDraftAge } from '../../../lib/useDraft.js'

/**
 * Right-anchored drawer holding the article metadata form, original-source
 * field, publish button, and draft-restore chip. On wide monitors it sits in
 * the empty right margin beside the centered editor; on narrower viewports
 * it overlays the right portion of the editor.
 *
 * Closed via the X button, Escape key, or clicking outside the panel.
 */
export default function MetadataDrawer({
  onClose,
  draftLoaded,
  draftSavedAt,
  onDiscardDraft,
  metadata,
  onMetadataChange,
  source,
  onSourceChange,
  content,
  user,
  readOnly,
  onPublishAnother,
  onPublishSuccess,
  excludeRef,
}) {
  const panelRef = useRef(null)

  useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    function handleClick(e) {
      // Ignore clicks on the toggle button that owns this drawer — the button's
      // own onClick will toggle it closed. Treating that click as "outside"
      // would close-then-reopen and leave the drawer stuck open.
      if (excludeRef?.current && excludeRef.current.contains(e.target)) return
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose, excludeRef])

  return (
    <div
      ref={panelRef}
      className="fixed top-0 md:top-14 right-0 bottom-0 z-40 w-full md:w-96 bg-neutral-950 border-l border-neutral-800 shadow-2xl flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
        <span className="text-sm font-medium text-neutral-200">Article details</span>
        <button
          onClick={onClose}
          aria-label="Close metadata drawer"
          className="w-7 h-7 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Draft chip */}
      {draftLoaded && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 flex-shrink-0">
          <span className="text-xs text-neutral-600">
            Draft{draftSavedAt ? ` · ${formatDraftAge(draftSavedAt)}` : ''}
          </span>
          <button
            onClick={onDiscardDraft}
            className="text-xs text-neutral-700 hover:text-red-500 transition-colors"
            aria-label="Discard draft"
          >discard</button>
        </div>
      )}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        <MetadataForm metadata={metadata} onChange={onMetadataChange} readOnly={readOnly} />
        <OriginalSourceField
          source={source}
          onChange={onSourceChange}
          metadata={metadata}
          onMetadataChange={onMetadataChange}
          readOnly={readOnly}
        />
      </div>

      {/* Publish footer */}
      <div className="p-4 border-t border-neutral-800 flex-shrink-0">
        <PublishButton
          content={content}
          metadata={metadata}
          source={source}
          user={user}
          onPublishAnother={onPublishAnother}
          onPublishSuccess={onPublishSuccess}
          readOnly={readOnly}
        />
      </div>
    </div>
  )
}
