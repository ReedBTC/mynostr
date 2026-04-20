/**
 * ImageUploadConfirm — pre-upload compression picker.
 *
 * Shared across every upload surface (profile avatar/banner, note
 * composer, longform cover + inline images). Each call site drives it
 * via the useImageUploadFlow hook:
 *
 *   const { requestUpload, element } = useImageUploadFlow()
 *   async function onFile(file) {
 *     const ready = await requestUpload(file) // null if cancelled
 *     if (ready) await uploadToBlossom(ready)
 *   }
 *   return <>{yourUI}{element}</>
 *
 * Desktop: centered modal. Mobile: bottom sheet with the same options.
 * Non-compressible files (GIF/SVG/tiny) bypass the picker entirely —
 * requestUpload resolves immediately with the original File.
 *
 * Size previews for each level compute in parallel when the modal opens.
 * Each option label shows "—" while computing, then the compressed size.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  COMPRESSION_LEVELS,
  DEFAULT_COMPRESSION_LEVEL,
  compressImage,
  formatBytes,
  isCompressible,
} from '../lib/imageCompress.js'
import { useIsMobile } from '../hooks/useIsMobile.js'

// Files this small don't benefit from the picker — re-encode overhead
// and user friction both outweigh any savings.
const SKIP_PICKER_UNDER_BYTES = 400 * 1024

const LEVEL_ORDER = ['none', 'low', 'medium', 'high']

export function useImageUploadFlow() {
  const [state, setState] = useState(null) // { file, resolve } | null

  const requestUpload = useCallback((file) => {
    return new Promise((resolve) => {
      if (!file) { resolve(null); return }
      // Small files or non-raster: skip the picker, hand back as-is.
      if (!isCompressible(file) || file.size < SKIP_PICKER_UNDER_BYTES) {
        resolve(file)
        return
      }
      // If a prior request is still pending (caller fired again before the
      // modal was answered), resolve the stale one with null so its await
      // doesn't hang forever when we overwrite state.
      setState(prev => {
        prev?.resolve(null)
        return { file, resolve }
      })
    })
  }, [])

  const handleConfirm = useCallback((finalFile) => {
    if (state) state.resolve(finalFile)
    setState(null)
  }, [state])

  const handleCancel = useCallback(() => {
    if (state) state.resolve(null)
    setState(null)
  }, [state])

  const element = state ? (
    <ImageUploadConfirm
      file={state.file}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null

  return { requestUpload, element }
}

function LevelButton({ level, selected, onSelect, sizeLabel, disabled }) {
  const info = COMPRESSION_LEVELS[level]
  return (
    <button
      type="button"
      onClick={() => onSelect(level)}
      disabled={disabled}
      className={`w-full text-left px-3 py-2 rounded border transition-colors ${
        selected
          ? 'border-purple-500 bg-purple-950/40'
          : 'border-neutral-700 bg-neutral-900 hover:border-neutral-500'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-neutral-100">{info.label}</span>
        <span className="text-[11px] text-neutral-400 tabular-nums">{sizeLabel}</span>
      </div>
      <p className="text-[11px] text-neutral-500 mt-0.5">{info.desc}</p>
    </button>
  )
}

function ImageUploadConfirm({ file, onConfirm, onCancel }) {
  const isMobile = useIsMobile()
  const [selected, setSelected] = useState(DEFAULT_COMPRESSION_LEVEL)
  const [sizes, setSizes] = useState({ none: file.size }) // byte size by level
  const [busy, setBusy] = useState(false)
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file])

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl])

  // Compute compressed size per level sequentially — each encode is a
  // main-thread canvas op, and running 3 of them in parallel on a large
  // photo freezes mid-range mobile for seconds. Medium first (it's the
  // default selection, so its size label is what the user stares at),
  // then high (cheapest), then low (most expensive).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      for (const level of ['medium', 'high', 'low']) {
        if (cancelled) return
        try {
          const out = await compressImage(file, level)
          if (cancelled) return
          setSizes(prev => ({ ...prev, [level]: out.size }))
        } catch {
          if (cancelled) return
          setSizes(prev => ({ ...prev, [level]: file.size }))
        }
      }
    })()
    return () => { cancelled = true }
  }, [file])

  // Escape to cancel — matches other modals in the app.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function handleUpload() {
    if (busy) return
    setBusy(true)
    try {
      const out = await compressImage(file, selected)
      onConfirm(out)
    } catch {
      onConfirm(file) // Fall back to original — never block the upload.
    }
  }

  const originalLabel = formatBytes(file.size)

  const body = (
    <>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-neutral-100">Upload image</h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-neutral-500 hover:text-neutral-200 text-lg leading-none"
          aria-label="Cancel"
        >
          ×
        </button>
      </div>

      <div className="flex gap-3 mb-3">
        <img
          src={previewUrl}
          alt=""
          className="w-20 h-20 rounded object-cover shrink-0 border border-neutral-800"
        />
        <div className="min-w-0 flex-1 text-[11px] text-neutral-400">
          <p className="truncate text-neutral-200" title={file.name}>{file.name}</p>
          <p className="mt-0.5">Original: {originalLabel}</p>
          <p className="mt-0.5 text-neutral-500">
            Compressed images upload faster and are cheaper to load on mobile.
          </p>
        </div>
      </div>

      <div className="space-y-1.5 mb-4">
        {LEVEL_ORDER.map(level => (
          <LevelButton
            key={level}
            level={level}
            selected={selected === level}
            onSelect={setSelected}
            sizeLabel={sizes[level] != null ? formatBytes(sizes[level]) : '…'}
            disabled={busy}
          />
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleUpload}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors disabled:opacity-50"
        >
          {busy ? 'Preparing…' : 'Upload'}
        </button>
      </div>
    </>
  )

  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 bg-black/60 z-[60]"
          onClick={onCancel}
        />
        <div
          className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-neutral-700 rounded-t-lg z-[61] p-4 pb-6"
          style={{ maxHeight: '85vh', overflowY: 'auto' }}
        >
          {body}
        </div>
      </>
    )
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
      onMouseDown={onCancel}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-sm p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  )
}
