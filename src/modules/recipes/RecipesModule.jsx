/**
 * RecipesModule — Module 1 (Week 1–2)
 * Kind 30023 long-form events tagged with #recipe.
 * Three sub-features: Publisher · Community Feed · Cookbook Builder & Export
 */
export default function RecipesModule() {
  return <ComingSoon module="Recipes" week="1–2" description="Publish, discover, and save Nostr recipes. Community feed + personal cookbook with .md and .epub export." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">🍳</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
