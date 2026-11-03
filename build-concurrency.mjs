// Bound independent esbuild jobs, retaining input order and settling active
// writes before propagating an error to callers that may clean up outputs.
export async function mapBuilds(items, run) {
  const results = new Array(items.length)
  let cursor = 0
  let failed = false
  let failure
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++
      try {
        results[index] = await run(items[index])
      } catch (error) {
        if (!failed) failure = error
        failed = true
      }
    }
  }))
  if (failed) throw failure
  return results
}
