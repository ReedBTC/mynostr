/**
 * SessionShippingOptionsContext — single source of truth for the SESSION
 * user's kind 30406 shipping options across the marketplace module.
 *
 * Why this exists: the Sell composer's Shipping tab and the marketplace's
 * Shipping Options tab both render the same catalog of the seller's own
 * shipping options. Without a shared instance, each surface's
 * useShippingOptions hook holds independent state — so creating an
 * option in one surface doesn't appear in the other until it remounts
 * or refreshes. Mirrors SessionCollectionsContext.
 *
 * Mounted once in MarketplaceModule with the session user's pubkey.
 * Consumers (ShippingOptionsTab, ShippingTab in SellComposer) read from
 * context rather than firing their own useShippingOptions call.
 *
 * VIEWING someone else's shipping options would need a separate hook
 * call with that pubkey — this context is only for the signed-in
 * seller's own catalog.
 */
import { createContext, useContext } from 'react'

export const SessionShippingOptionsContext = createContext(null)

/**
 * Returns the session user's shipping-options hook output, or null if
 * the marketplace module hasn't mounted / there's no signed-in session.
 * Callers should handle null gracefully — typically by hiding shipping-
 * mutation UI when the session has no signer anyway.
 */
export function useSessionShippingOptions() {
  return useContext(SessionShippingOptionsContext)
}
