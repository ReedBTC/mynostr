/**
 * NIP-57.5 zap-split parsing + msat allocation.
 *
 * Each `zap` tag on a note: ['zap', pubkey, relay, weight]. Weights are
 * ratios — typically sum to 100 (treated as %), but the spec is silent
 * on that so we treat them as pure ratios.
 *
 * Lifted out of NoteCard so payZapSplits and any other consumer can
 * reuse the parser without pulling the whole feed module.
 */

/**
 * Parse the zap tags off an event. Returns an empty array when there are
 * none (callers can `if (splits.length)` to branch).
 *
 * Output shape: `{ pubkey, relay, weight, pct }`. `pct` is the rounded
 * display value; `weight` is the raw ratio used by allocateMsats.
 */
export function extractZapSplits(tags) {
  if (!Array.isArray(tags)) return []
  const out = []
  for (const t of tags) {
    if (!Array.isArray(t) || t[0] !== 'zap' || !t[1]) continue
    if (!/^[0-9a-fA-F]{64}$/.test(t[1])) continue
    const weight = Math.max(0, Number(t[3]) || 1)
    if (weight <= 0) continue
    out.push({ pubkey: t[1].toLowerCase(), relay: t[2] || '', weight })
  }
  const totalWeight = out.reduce((s, z) => s + z.weight, 0)
  return out.map(z => ({
    ...z,
    pct: totalWeight > 0 ? Math.round(z.weight / totalWeight * 100) : 0,
  }))
}

/**
 * Allocate `totalMsats` across `splits` proportionally by weight.
 * Floors each share to the nearest whole sat (some LNURL providers —
 * Fountain, in particular — reject sub-sat amounts even though msats
 * are technically valid). The rounding remainder is added to the
 * highest-weight recipient so the total matches exactly and small-share
 * recipients aren't squeezed below LNURL minSendable.
 *
 * Returns each split with an `msats` field added.
 */
export function allocateMsats(totalMsats, splits) {
  const totalWeight = splits.reduce((s, z) => s + z.weight, 0)
  if (totalWeight <= 0) return []
  const allocations = splits.map(z => ({
    ...z,
    msats: Math.floor((totalMsats * z.weight / totalWeight) / 1000) * 1000,
  }))
  const distributed = allocations.reduce((s, a) => s + a.msats, 0)
  const remainder = Math.floor((totalMsats - distributed) / 1000) * 1000
  if (remainder > 0 && allocations.length > 0) {
    let maxIdx = 0
    for (let i = 1; i < allocations.length; i++) {
      if (allocations[i].weight > allocations[maxIdx].weight) maxIdx = i
    }
    allocations[maxIdx].msats += remainder
  }
  return allocations
}
