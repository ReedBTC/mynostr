/**
 * ImportExportDisclosure — normally-closed <details> block used at the
 * top of every composer (Notes, Articles, Events, Marketplace).
 *
 * Frames file upload / paste-id-to-load / export-current-draft as
 * optional power-user actions instead of leaving them as a row of
 * unexplained controls (which testers read as required fields).
 *
 * Props are minimal and presentational — all state (errors, loading,
 * input value) is owned by the parent composer so each module keeps
 * its existing wiring.
 */
import { useRef, useState } from 'react'

export default function ImportExportDisclosure({
  // Upload
  acceptedFileTypes,        // e.g. ".json,application/json" or ".md,.markdown"
  onImportFile,             // (file) => Promise<{ok, error}> | void
  importLabel = 'Upload',
  importTitle,              // hover title for the upload button
  importLoading = false,
  importError = '',

  // Paste id
  pasteIdValue,             // controlled string
  onPasteIdChange,          // (value) => void
  onLoadId,                 // () => Promise<{ok, error}> | void
  pasteIdPlaceholder = 'naddr1… / nevent1…',
  loadButtonLabel = 'Load',
  loadLoading = false,
  loadError = '',

  // Export
  exportLabel = 'Export',
  onExport,                 // () => void  — used when exportMenuItems is empty
  exportDisabled = false,
  exportTitle,
  exportMenuItems,          // optional: [{ label, onClick, disabled? }, …]
}) {
  const fileRef = useRef(null)
  const [exportOpen, setExportOpen] = useState(false)

  const error = importError || loadError

  return (
    <details className="group rounded border border-neutral-800 bg-neutral-950/40">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200 flex items-center gap-2 select-none">
        <svg
          className="w-3 h-3 transition-transform group-open:rotate-90"
          viewBox="0 0 12 12"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4z" />
        </svg>
        <span>Import / Export Options</span>
      </summary>

      <div className="px-3 pb-3 pt-1 space-y-2">
        <p className="text-[11px] leading-snug text-neutral-500">
          Optional — Import/Export a draft file or load an existing event ID as a draft.
        </p>

        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Upload */}
          <input
            ref={fileRef}
            type="file"
            accept={acceptedFileTypes}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f && onImportFile) onImportFile(f)
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={importLoading}
            title={importTitle}
            className="shrink-0 text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            {importLoading ? '…' : importLabel}
          </button>

          {/* Export — simple button or dropdown */}
          {exportMenuItems && exportMenuItems.length > 0 ? (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setExportOpen((v) => !v)}
                disabled={exportDisabled}
                title={exportTitle}
                className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40 flex items-center gap-1"
              >
                {exportLabel}
                <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                  <path d="M2 4l4 4 4-4z" />
                </svg>
              </button>
              {exportOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setExportOpen(false)}
                  />
                  <div className="absolute right-0 mt-1 z-20 min-w-[10rem] rounded border border-neutral-700 bg-neutral-900 shadow-lg py-1">
                    {exportMenuItems.map((item, i) => (
                      <button
                        key={i}
                        type="button"
                        disabled={item.disabled}
                        onClick={() => {
                          setExportOpen(false)
                          item.onClick?.()
                        }}
                        className="block w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={onExport}
              disabled={exportDisabled}
              title={exportTitle}
              className="shrink-0 text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
            >
              {exportLabel}
            </button>
          )}

          {/* Paste id + Load — last on the row so the input can flex-grow
              to fill remaining horizontal space up to where Load lands. */}
          <form
            onSubmit={(e) => { e.preventDefault(); if (onLoadId) onLoadId() }}
            className="flex items-center gap-1 flex-1 min-w-[12rem]"
          >
            <input
              type="search"
              value={pasteIdValue ?? ''}
              onChange={(e) => onPasteIdChange?.(e.target.value)}
              placeholder={pasteIdPlaceholder}
              disabled={loadLoading}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={loadLoading || !(pasteIdValue ?? '').trim()}
              className="shrink-0 text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
            >
              {loadLoading ? '…' : loadButtonLabel}
            </button>
          </form>
        </div>

        {error && (
          <div className="text-xs text-red-400">
            {error}
          </div>
        )}
      </div>
    </details>
  )
}
