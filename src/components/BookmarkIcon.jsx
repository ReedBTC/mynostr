/**
 * BookmarkIcon — the classic ribbon/pennant shape used across every
 * bookmark surface. Matches Primal's visual metaphor.
 *
 * `filled` drives the saved/unsaved state:
 *   - false → stroke-only outline (ready to save)
 *   - true  → solid fill (saved — parent typically colors it blue)
 *
 * Color comes from the parent's `text-*` class via `currentColor`, so
 * each caller picks its own palette (saved = blue-400, default = neutral,
 * error = red, etc).
 */
export default function BookmarkIcon({ filled = false, size = 12, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 2h8a1 1 0 0 1 1 1v12l-5-3-5 3V3a1 1 0 0 1 1-1z" />
    </svg>
  )
}
