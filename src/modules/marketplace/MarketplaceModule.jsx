/**
 * MarketplaceModule — Module 5 (Weeks 1–2)
 * NIP-15 kind 30402 listing publisher and manager.
 */
export default function MarketplaceModule() {
  return <ComingSoon module="Marketplace" week="1–2" description="Publish and manage NIP-15 kind 30402 marketplace listings. Price in sats, USD, or EUR. Up to 5 images. Mark items as available or sold." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">🛒</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
