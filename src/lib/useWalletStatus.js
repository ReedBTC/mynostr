import { useEffect, useState } from 'react'
import * as nwc from './nwc.js'
import * as webln from './webln.js'

/**
 * Subscribe to NWC + WebLN connect/disconnect events and return the
 * active wallet's status. NWC takes precedence when both are connected
 * (it's the explicit/intentional connect path; WebLN can re-enable
 * silently from the persisted flag).
 *
 * Status shape: { connected, alias?, kind?: 'nwc' | 'webln' }
 */
function compute() {
  const n = nwc.getStatus()
  if (n.connected) return { ...n, kind: 'nwc' }
  const w = webln.getStatus()
  if (w.connected) return { connected: true, alias: w.alias, kind: 'webln' }
  // Neither connected yet, but NWC's ensureReady() may be probing the
  // saved connection — surface it so the wallet row can show
  // "Checking wallet…" instead of "Connect Wallet" during cold load.
  // WebLN doesn't probe at boot (we removed silent re-enable), so
  // probing is purely a NWC-side signal.
  return { connected: false, probing: !!n.probing }
}

export function useWalletStatus() {
  const [status, setStatus] = useState(compute)
  useEffect(() => {
    const update = () => setStatus(compute())
    const offN = nwc.onChange(update)
    const offW = webln.onChange(update)
    return () => { offN(); offW() }
  }, [])
  return status
}
