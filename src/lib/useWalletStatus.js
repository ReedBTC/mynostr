import { useEffect, useState } from 'react'
import * as nwc from './nwc.js'

/**
 * Subscribe to NWC connect/disconnect events and return the current status.
 * Returns the same shape as nwc.getStatus() — see nwc.js for shapes.
 *
 * Re-renders the consuming component on every status change so the wallet
 * dot / alias / Connect button stays in sync without polling.
 */
export function useWalletStatus() {
  const [status, setStatus] = useState(() => nwc.getStatus())
  useEffect(() => nwc.onChange(setStatus), [])
  return status
}
