/** The most rounds a chunk holds: dtalgod's most rounds a query request may list (`MaxQueryRounds`). */
export const MAX_CHUNK_ROUNDS = 256

/**
 * Splits `roundCount` rounds into chunks of at most `maxRounds` rounds each (and at most `MAX_CHUNK_ROUNDS`), for the
 * fewest requests in all, where a chunk of `s` rounds takes `requestsAt(s)` requests (at least 1, and never fewer for more
 * rounds). Of the splits with the fewest requests it takes one with the fewest chunks, and spreads the rounds evenly over
 * them when that needs no more requests.
 *
 * Exact. A chunk can grow to the largest size of its cost for free, so only those sizes are tried. Take the size `best`
 * with the fewest requests per round (the larger on a tie): the chunks of other sizes number fewer than `best` in all, as
 * any `best` of them contain some whose rounds add up to a multiple of `best` (by their running totals modulo `best`), which
 * chunks of size `best` can replace for fewer requests, or as many in fewer chunks. So a search over the first
 * `(best - 1) × maxRounds` rounds covers the rest with chunks of size `best`. It takes at most about `maxRounds³` steps
 * (17 million at 256, about 150 ms) for each query target, and far fewer when few sizes have a cost of their own (a few ms
 * at the node's defaults).
 *
 * @internal Used by `QueryManager`; not part of the public API.
 * @param roundCount The rounds to split, at least 1
 * @param maxRounds The most rounds a chunk may hold, at least 1
 * @param requestsAt The requests a chunk of this many rounds takes
 * @returns The chunk sizes, the larger ones first, summing to `roundCount`
 */
export function planRoundChunks(roundCount: number, maxRounds: number, requestsAt: (rounds: number) => number): number[] {
  const top = Math.max(1, Math.min(maxRounds, roundCount, MAX_CHUNK_ROUNDS))
  const costAt = [0]
  for (let s = 1; s <= top; s++) costAt.push(requestsAt(s))

  // The largest size of each cost, and of those the one with the fewest requests per round (the larger on a tie)
  const sizes: number[] = []
  for (let s = 1; s <= top; s++) if (s === top || costAt[s + 1] > costAt[s]) sizes.push(s)
  const best = sizes.reduce((b, s) => (costAt[s] * b < costAt[b] * s || (costAt[s] * b === costAt[b] * s && s > b) ? s : b))

  // The fewest requests (then chunks) to cover at least w rounds, for w up to `span`, and the last size taken
  const span = Math.min(roundCount, (best - 1) * top)
  const cost = new Float64Array(span + 1)
  const chunks = new Float64Array(span + 1)
  const last = new Int32Array(span + 1)
  for (let w = 1; w <= span; w++) {
    cost[w] = Infinity
    for (const s of sizes) {
      const from = Math.max(0, w - s)
      const c = cost[from] + costAt[s]
      if (c < cost[w] || (c === cost[w] && chunks[from] + 1 < chunks[w])) [cost[w], chunks[w], last[w]] = [c, chunks[from] + 1, s]
    }
  }

  // The rest of the rounds in chunks of the best size
  let fewest = { requests: Infinity, chunks: Infinity, w: 0, rest: 0 }
  for (let w = 0; w <= span; w++) {
    const rest = Math.ceil((roundCount - w) / best)
    const requests = cost[w] + rest * costAt[best]
    if (requests < fewest.requests || (requests === fewest.requests && chunks[w] + rest < fewest.chunks))
      fewest = { requests, chunks: chunks[w] + rest, w, rest }
  }
  const split: number[] = new Array<number>(fewest.rest).fill(best)
  for (let w = fewest.w; w > 0; w = Math.max(0, w - last[w])) split.push(last[w])
  split.sort((a, b) => b - a)

  // Spread evenly, if that needs no more requests
  const count = split.length
  const base = Math.floor(roundCount / count)
  const longer = roundCount % count
  if ((longer ? longer * costAt[base + 1] : 0) + (count - longer) * costAt[base] <= fewest.requests)
    return Array.from({ length: count }, (_, i) => base + (i < longer ? 1 : 0))

  // Else cut the largest chunks down to the rounds there are: chunks only shrink, so their requests don't grow
  const covered = (h: number) => split.reduce((n, s) => n + Math.min(s, h), 0)
  let [low, level] = [1, split[0]]
  while (low < level) {
    const mid = Math.floor((low + level) / 2)
    if (covered(mid) >= roundCount) level = mid
    else low = mid + 1
  }
  const trimmed = split.map((s) => Math.min(s, level))
  for (let i = trimmed.lastIndexOf(level), excess = covered(level) - roundCount; excess > 0; i--, excess--) trimmed[i]--
  return trimmed
}
