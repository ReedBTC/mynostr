/**
 * EventDraftsTray — left pane for the events composer.
 *
 * Direct port of SellDraftsTray (marketplace) so the two trays feel
 * identical to use. Desktop: slim left column, always visible.
 * Mobile: bottom sheet opened from a "Drafts (N)" chip in the
 * composer top action row.
 *
 * Each row shows: title (or "Untitled event"), date subline, hero
 * thumbnail, status dot, trash button (two-click confirm), reorder
 * arrows (publish-queue order matches array order).
 *
 * Footer actions:
 *   • Multi-JSON Import — drop in any number of kind 31922/31923 JSON files
 *   • Export All Drafts
 *   • Clear All Drafts  (modal confirm)
 *   • Publish All       (modal confirm)
 *
 * Single-import, single-export, and the naddr/nevent loader live in
 * the composer's top action row, not here — they're per-current-draft
 * actions that belong next to the editor.
 */
import { useEffect, useRef, useState } from 'react'
import { isSafeUrl } from '../../../lib/utils.js'

// Local mirror of NIP-52 kinds we accept as event coords; tray-internal
// only, kept here to avoid pulling more imports than necessary.
const KIND_DATE_EVENT = 31922
const KIND_TIME_EVENT = 31923

function StatusDot({ status }) {
  const cls =
    status === 'publishing' ? 'bg-amber-400 animate-pulse'
      : status === 'published' ? 'bg-green-500'
      : status === 'failed'    ? 'bg-red-500'
      : 'bg-neutral-600'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} aria-hidden />
}

function TrashIcon({ className = 'w-3 h-3' }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.664 8.093A1.75 1.75 0 0 0 5.457 15h5.086a1.75 1.75 0 0 0 1.743-1.407L12.95 5.5h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm1.5 0A.75.75 0 0 1 7.25 2.5h1.5a.75.75 0 0 1 .75.75V4h-3V3.25Z" clipRule="evenodd" />
    </svg>
  )
}

function ConfirmDialog({ title, body, confirmLabel, confirmTone = 'purple', onCancel, onConfirm }) {
  const confirmClass = confirmTone === 'red'
    ? 'bg-red-600 hover:bg-red-500'
    : 'bg-purple-600 hover:bg-purple-500'
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-sm p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium text-neutral-100 mb-1.5">{title}</h3>
        <p className="text-xs text-neutral-400 mb-4">{body}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`text-xs px-3 py-1.5 rounded text-white font-semibold transition-colors ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function previewTitle(snapshot) {
  const t = (snapshot?.title || '').trim()
  if (t) return t.length > 48 ? t.slice(0, 48) + '…' : t
  return 'Untitled event'
}

// Concise event-time line for the row. Shows "Mon Apr 28 · 7:00 PM"
// when both date+time are present; falls back gracefully on partial
// data so a fresh draft with just a date doesn't show a phantom
// timestamp. All-day events get a date-only render.
function previewDate(snapshot) {
  const ymd = snapshot?.startDate
  if (!ymd) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return ymd
  const y = +m[1], mo = +m[2] - 1, d = +m[3]
  const date = new Date(Date.UTC(y, mo, d))
  const dateStr = date.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  })
  if (snapshot?.allDay) return dateStr
  const time = snapshot?.startTime
  if (!time) return dateStr
  const tm = /^(\d{2}):(\d{2})$/.exec(time)
  if (!tm) return dateStr
  const h = +tm[1], mi = +tm[2]
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${dateStr} · ${h12}:${String(mi).padStart(2, '0')} ${ampm}`
}

function DraftRow({ draft, isCurrent, index, total, onSelect, onDelete, onMove }) {
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!pending) return
    const id = setTimeout(() => setPending(false), 4000)
    return () => clearTimeout(id)
  }, [pending])

  if (pending) {
    return (
      <div className="px-2.5 py-2 rounded bg-red-950/40 border border-red-900/60">
        <p className="text-xs text-red-300 mb-1.5 truncate">
          Delete draft: <span className="text-red-200">{previewTitle(draft.snapshot)}</span>
        </p>
        <div className="flex gap-1.5">
          <button
            onClick={() => setPending(false)}
            className="flex-1 text-[11px] text-neutral-300 hover:text-neutral-100 px-2 py-1 rounded border border-neutral-700 hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            className="flex-1 text-[11px] text-white bg-red-600 hover:bg-red-500 px-2 py-1 rounded font-semibold transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    )
  }

  const cover = draft.snapshot?.image
  const dateStr = previewDate(draft.snapshot)

  return (
    <div
      onClick={onSelect}
      className={`group flex items-start gap-2 px-2 py-2 rounded cursor-pointer transition-colors ${
        isCurrent
          ? 'bg-purple-950/40 border border-purple-800/60'
          : 'border border-transparent hover:bg-neutral-800/60'
      }`}
    >
      {/* Reorder arrows — left edge of the row, far from trash. */}
      <div className="flex flex-col items-center justify-center shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity self-stretch">
        <button
          onClick={e => { e.stopPropagation(); onMove?.(-1) }}
          disabled={index === 0}
          title="Move up"
          aria-label="Move up in publish queue"
          className="text-neutral-400 hover:text-neutral-100 disabled:opacity-30 disabled:pointer-events-none px-2 py-1 md:px-1.5 md:py-0.5 leading-none text-sm"
        >▲</button>
        <button
          onClick={e => { e.stopPropagation(); onMove?.(1) }}
          disabled={index === total - 1}
          title="Move down"
          aria-label="Move down in publish queue"
          className="text-neutral-400 hover:text-neutral-100 disabled:opacity-30 disabled:pointer-events-none px-2 py-1 md:px-1.5 md:py-0.5 leading-none text-sm"
        >▼</button>
      </div>

      {/* Thumbnail */}
      <div className="w-9 h-9 rounded bg-neutral-800 border border-neutral-700 flex-shrink-0 overflow-hidden flex items-center justify-center text-neutral-600 text-sm">
        {cover && isSafeUrl(cover) ? (
          <img
            src={cover}
            alt=""
            className="w-full h-full object-cover"
            onError={e => { e.currentTarget.style.display = 'none' }}
          />
        ) : (
          <span aria-hidden>📅</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <StatusDot status={draft.status} />
          <span className="text-[10px] text-neutral-500 tabular-nums shrink-0">{index + 1}.</span>
          <p className={`text-xs truncate flex-1 ${isCurrent ? 'text-neutral-100' : 'text-neutral-400'}`}>
            {previewTitle(draft.snapshot)}
          </p>
        </div>
        {dateStr && <p className="text-[10px] text-neutral-500 mt-0.5 truncate">{dateStr}</p>}
        {draft.status === 'failed' && draft.publishError && (
          <p className="text-[10px] text-red-400 mt-0.5 truncate">{draft.publishError}</p>
        )}
        {draft.status === 'published' && (
          <p className="text-[10px] text-green-500 mt-0.5">Published</p>
        )}
      </div>

      <button
        onClick={e => { e.stopPropagation(); setPending(true) }}
        title="Delete draft"
        aria-label="Delete draft"
        className="shrink-0 text-neutral-500 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-2 -m-1 md:p-1"
      >
        <TrashIcon />
      </button>
    </div>
  )
}

export default function EventDraftsTray({
  drafts,
  currentDraftId,
  onSelectDraft,
  onCreateDraft,
  onDeleteDraft,
  onDeleteAllDrafts,
  onImportDrafts,
  onExportAllDrafts,
  onPublishAll,
  onMoveDraft,
  onFindDuplicateDTags,
  onRegenerateDTags,
  isMobileOpen = false,
  onMobileClose,
  isMobile = false,
}) {
  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false)
  const [confirmClearOpen,   setConfirmClearOpen]   = useState(false)
  const [dupDTagInfo,        setDupDTagInfo]        = useState(null)
  const [importStatus, setImportStatus] = useState(null)
  const [exportStatus, setExportStatus] = useState(null)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef(null)

  const publishable = drafts.filter(d =>
    d.snapshot?.title?.trim() && d.snapshot?.startDate && d.status !== 'published'
  )
  const exportable  = drafts.filter(d => d.snapshot?.title?.trim())
  const anyPublishing = drafts.some(d => d.status === 'publishing')
  const canClearAll = drafts.length > 1 || Boolean(drafts[0]?.snapshot?.title?.trim())

  function requestPublishAll() {
    if (publishable.length === 0 || anyPublishing) return
    const dups = onFindDuplicateDTags ? onFindDuplicateDTags() : []
    if (dups.length > 0) {
      setDupDTagInfo({ dups })
      return
    }
    setConfirmPublishOpen(true)
  }
  function doPublishAll() {
    setConfirmPublishOpen(false)
    onPublishAll()
    if (isMobile && onMobileClose) onMobileClose()
  }
  function regenerateAndPublish() {
    if (!dupDTagInfo || !onRegenerateDTags) return
    const ids = []
    for (const group of dupDTagInfo.dups) {
      for (const d of group.drafts) ids.push(d.id)
    }
    onRegenerateDTags(ids)
    setDupDTagInfo(null)
    setConfirmPublishOpen(true)
  }
  function requestClearAll() {
    if (!canClearAll || anyPublishing) return
    setConfirmClearOpen(true)
  }
  function doClearAll() {
    setConfirmClearOpen(false)
    onDeleteAllDrafts?.()
    if (isMobile && onMobileClose) onMobileClose()
  }

  async function handleImportFiles(files) {
    if (!onImportDrafts || files.length === 0) return
    setImportStatus(null)
    setImporting(true)
    try {
      const r = await onImportDrafts(files)
      setImportStatus(r)
      if (r.errors.length === 0 && r.imported > 0) {
        setTimeout(() => setImportStatus(null), 3000)
      }
    } finally {
      setImporting(false)
    }
  }

  function handleExportAll() {
    if (!onExportAllDrafts || exportable.length === 0) return
    const r = onExportAllDrafts()
    setExportStatus(r)
    setTimeout(() => setExportStatus(null), 3000)
  }

  const list = (
    <>
      <div className="flex items-center justify-between gap-1.5 px-2.5 py-2 border-b border-neutral-800">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500 font-medium">
          Drafts ({drafts.length})
        </span>
        <button
          onClick={() => { onCreateDraft(); if (isMobile && onMobileClose) onMobileClose() }}
          title="New draft"
          className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5">
        {drafts.map((d, i) => (
          <DraftRow
            key={d.id}
            draft={d}
            index={i}
            total={drafts.length}
            isCurrent={d.id === currentDraftId}
            onSelect={() => {
              onSelectDraft(d.id)
              if (isMobile && onMobileClose) onMobileClose()
            }}
            onDelete={() => onDeleteDraft(d.id)}
            onMove={(delta) => onMoveDraft?.(d.id, delta)}
          />
        ))}
      </div>

      <div className="border-t border-neutral-800 p-2 space-y-1.5">
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = [...(e.target.files || [])]
            e.target.value = ''
            await handleImportFiles(files)
          }}
        />
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={importing || anyPublishing}
          className="w-full text-xs py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 disabled:text-neutral-600 disabled:pointer-events-none transition-colors"
        >
          {importing ? 'Importing…' : 'Multi-JSON Import'}
        </button>

        <button
          onClick={handleExportAll}
          disabled={exportable.length === 0 || anyPublishing}
          className="w-full text-xs py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 disabled:text-neutral-600 disabled:pointer-events-none transition-colors"
        >
          Export All Drafts ({exportable.length})
        </button>
        <button
          onClick={requestClearAll}
          disabled={!canClearAll || anyPublishing}
          className="w-full text-xs py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-900 disabled:text-neutral-600 disabled:pointer-events-none transition-colors"
        >
          Clear All Drafts ({drafts.length})
        </button>
        <button
          onClick={requestPublishAll}
          disabled={publishable.length === 0 || anyPublishing}
          className="w-full text-xs py-1.5 rounded bg-purple-700/90 hover:bg-purple-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white transition-colors"
        >
          {anyPublishing ? 'Publishing…' : `Publish All (${publishable.length})`}
        </button>

        {importStatus && (importStatus.imported > 0 || importStatus.errors.length > 0) && (
          <div className="text-[10px] text-neutral-400 pt-1">
            {importStatus.imported > 0 && (
              <p className="text-green-500">Imported {importStatus.imported} event{importStatus.imported === 1 ? '' : 's'}</p>
            )}
            {importStatus.errors.length > 0 && (
              <details className="mt-0.5">
                <summary className="text-red-400 cursor-pointer">
                  {importStatus.errors.length} file{importStatus.errors.length === 1 ? '' : 's'} skipped
                </summary>
                <ul className="mt-1 space-y-0.5 text-red-300">
                  {importStatus.errors.map((err, i) => (
                    <li key={i} className="truncate">{err}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {exportStatus && exportStatus.exported > 0 && (
          <p className="text-[10px] text-green-500 pt-1">
            Exported {exportStatus.exported} event{exportStatus.exported === 1 ? '' : 's'}
            {exportStatus.skipped > 0 ? ` (${exportStatus.skipped} skipped — empty)` : ''}
          </p>
        )}
      </div>
    </>
  )

  if (isMobile) {
    if (!isMobileOpen) return null
    return (
      <>
        <div
          className="fixed inset-0 bg-black/60 z-40"
          onClick={onMobileClose}
        />
        <div
          className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-neutral-700 rounded-t-lg z-50 flex flex-col"
          style={{ maxHeight: '70vh' }}
        >
          {list}
        </div>
        {confirmPublishOpen && (
          <ConfirmDialog
            title={`Publish ${publishable.length} event${publishable.length === 1 ? '' : 's'}?`}
            body="Each event will be signed and published in order. This can't be undone — events on Nostr relays aren't reliably deletable."
            confirmLabel="Publish All"
            onCancel={() => setConfirmPublishOpen(false)}
            onConfirm={doPublishAll}
          />
        )}
        {confirmClearOpen && (
          <ConfirmDialog
            title={`Delete all ${drafts.length} draft${drafts.length === 1 ? '' : 's'}?`}
            body="Every draft in this browser will be removed and replaced with one empty draft. This can't be undone — export anything important first."
            confirmLabel="Delete all"
            confirmTone="red"
            onCancel={() => setConfirmClearOpen(false)}
            onConfirm={doClearAll}
          />
        )}
        {dupDTagInfo && (
          <DupDTagDialog
            info={dupDTagInfo}
            onCancel={() => setDupDTagInfo(null)}
            onRegenerate={regenerateAndPublish}
          />
        )}
      </>
    )
  }

  return (
    <aside className="hidden md:flex flex-col w-[220px] flex-shrink-0 border-r border-neutral-800 bg-neutral-900/40">
      {list}
      {confirmPublishOpen && (
        <ConfirmDialog
          title={`Publish ${publishable.length} event${publishable.length === 1 ? '' : 's'}?`}
          body="Each event will be signed and published in order. This can't be undone — events on Nostr relays aren't reliably deletable."
          confirmLabel="Publish all"
          onCancel={() => setConfirmPublishOpen(false)}
          onConfirm={doPublishAll}
        />
      )}
      {confirmClearOpen && (
        <ConfirmDialog
          title={`Delete all ${drafts.length} draft${drafts.length === 1 ? '' : 's'}?`}
          body="Every draft in this browser will be removed and replaced with one empty draft. This can't be undone — export anything important first."
          confirmLabel="Delete all"
          confirmTone="red"
          onCancel={() => setConfirmClearOpen(false)}
          onConfirm={doClearAll}
        />
      )}
      {dupDTagInfo && (
        <DupDTagDialog
          info={dupDTagInfo}
          onCancel={() => setDupDTagInfo(null)}
          onRegenerate={regenerateAndPublish}
        />
      )}
    </aside>
  )
}

function DupDTagDialog({ info, onCancel, onRegenerate }) {
  const totalDrafts = info.dups.reduce((n, g) => n + g.drafts.length, 0)
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium text-neutral-100 mb-1.5">
          Cannot publish — drafts share Nostr identity
        </h3>
        <p className="text-xs text-neutral-400 mb-3">
          {totalDrafts} drafts share a <code className="text-neutral-300">d</code>-tag
          with another draft. Kind {KIND_DATE_EVENT}/{KIND_TIME_EVENT} is replaceable per
          (kind, pubkey, dTag) — publishing them all would silently
          overwrite each other on Nostr, leaving only the last one
          to publish.
        </p>
        <div className="border border-neutral-800 rounded p-2 mb-3 max-h-44 overflow-y-auto space-y-2">
          {info.dups.map((group, gi) => (
            <div key={gi} className="text-xs space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">
                Sharing dTag <code className="font-mono normal-case">{group.dTag.slice(0, 24)}{group.dTag.length > 24 ? '…' : ''}</code>
              </p>
              <ul className="space-y-0.5 pl-2">
                {group.drafts.map(d => (
                  <li key={d.id} className="text-neutral-300 truncate">
                    • {d.title || 'Untitled'}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-neutral-500 mb-4 leading-relaxed">
          Common cause: importing the same JSON template multiple times
          with the dTag preserved. Regenerate clears each affected
          draft's dTag so they each publish as a distinct event with
          a fresh random identity.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onRegenerate}
            className="text-xs px-3 py-1.5 rounded text-white font-semibold bg-purple-600 hover:bg-purple-500 transition-colors"
          >
            Regenerate dTags & continue
          </button>
        </div>
      </div>
    </div>
  )
}
