import { describe, expect, test } from 'vitest'
import { MAX_CHUNK_ROUNDS, planRoundChunks } from './query-plan'

/** The fewest requests over every split of `roundCount` rounds, and of those splits the fewest chunks, by brute force. */
const fewest = (roundCount: number, maxRounds: number, requestsAt: (rounds: number) => number) => {
  const best = [{ requests: 0, chunks: 0 }]
  for (let w = 1; w <= roundCount; w++) {
    best.push({ requests: Infinity, chunks: Infinity })
    for (let s = 1; s <= Math.min(maxRounds, w); s++) {
      const [requests, chunks] = [best[w - s].requests + requestsAt(s), best[w - s].chunks + 1]
      if (requests < best[w].requests || (requests === best[w].requests && chunks < best[w].chunks)) best[w] = { requests, chunks }
    }
  }
  return best[roundCount]
}

/** The rounds spread evenly over `count` chunks, the longer first. */
const even = (roundCount: number, count: number) =>
  Array.from({ length: count }, (_, i) => Math.floor(roundCount / count) + (i < roundCount % count ? 1 : 0))

/** A deterministic pseudo-random integer from 1 to n (mulberry32). */
const random = (() => {
  let seed = 42
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return 1 + (((t ^ (t >>> 14)) >>> 0) % n)
  }
})()

describe('planRoundChunks', () => {
  test('takes the fewest requests of any split, then the fewest chunks, spread evenly when that costs no more', () => {
    const maxRoundsSeen = new Set<number>()
    for (let t = 0; t < 2000; t++) {
      const [roundCount, maxCalls, totalCalls, callCount] = [
        random(t % 2 ? 60 : 300),
        random(1024),
        random(t % 4 ? 1024 : 50),
        random(3000),
      ]
      const maxRounds = Math.min(random(t % 5 ? 16 : 256), totalCalls)
      maxRoundsSeen.add(maxRounds)
      // Half with the node's request counts, half with any that never fall for more rounds
      const steps = Array.from({ length: maxRounds + 1 }, () => random(3) - 1)
      const requestsAt =
        t % 2
          ? (rounds: number) => Math.ceil(callCount / Math.max(1, Math.min(maxCalls, Math.floor(totalCalls / rounds))))
          : (rounds: number) => 1 + steps.slice(0, rounds).reduce((n, s) => n + s, 0)
      const split = planRoundChunks(roundCount, maxRounds, requestsAt)
      const requests = split.reduce((n, s) => n + requestsAt(s), 0)
      expect(split.reduce((n, s) => n + s, 0)).toBe(roundCount)
      expect(split.every((s, i) => s >= 1 && s <= maxRounds && (i === 0 || s <= split[i - 1]))).toBe(true)
      expect({ requests, chunks: split.length }).toEqual(fewest(roundCount, maxRounds, requestsAt))
      const spread = even(roundCount, split.length)
      if (spread.reduce((n, s) => n + requestsAt(s), 0) <= requests) expect(split).toEqual(spread)
    }
    // The limits vary: not mostly 1 round a chunk
    expect(maxRoundsSeen.size).toBeGreaterThan(100)
  })

  test('fewer chunks win a tie, then the rounds are spread evenly', () => {
    // 1 request a chunk: 10 rounds in 3 chunks, spread evenly
    expect(planRoundChunks(10, 4, () => 1)).toEqual([4, 3, 3])
    // As many requests as rounds: one chunk of all
    expect(planRoundChunks(3, 4, (rounds) => rounds)).toEqual([3])
    // 2 rounds take 2 requests, 1 takes 1: 3 rounds in 2 and 1 rather than 1, 1 and 1
    expect(planRoundChunks(3, 2, (rounds) => rounds)).toEqual([2, 1])
  })

  test('uneven when that needs fewer requests', () => {
    // At most 2 rounds a request for one request, 3 or more take 3: 11 rounds in 7, 2 and 2 for 5 requests
    expect(planRoundChunks(11, 7, (rounds) => (rounds <= 2 ? 1 : rounds === 3 ? 2 : 3))).toEqual([7, 2, 2])
  })

  test(`at most ${MAX_CHUNK_ROUNDS} rounds a chunk, whatever maxRounds is`, () => {
    expect(planRoundChunks(1000, Infinity, () => 1)).toEqual([250, 250, 250, 250])
    expect(planRoundChunks(100_000, 100_000, (rounds) => rounds).every((s) => s <= MAX_CHUNK_ROUNDS)).toBe(true)
    // And still the fewest requests within the cap
    const requestsAt = (rounds: number) => Math.ceil(216_000 / Math.max(1, Math.min(4096, Math.floor(65_536 / rounds))))
    expect(planRoundChunks(3000, 1000, requestsAt)).toEqual(planRoundChunks(3000, MAX_CHUNK_ROUNDS, requestsAt))
    const split = planRoundChunks(700, 1000, requestsAt)
    expect({ requests: split.reduce((n, s) => n + requestsAt(s), 0), chunks: split.length }).toEqual(
      fewest(700, MAX_CHUNK_ROUNDS, requestsAt),
    )
  })

  test('a million rounds plan quickly', () => {
    const started = performance.now()
    const split = planRoundChunks(1_000_000, 256, (rounds) => Math.ceil(715 / Math.floor(1024 / rounds)))
    expect(split.reduce((n, s) => n + s, 0)).toBe(1_000_000)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
