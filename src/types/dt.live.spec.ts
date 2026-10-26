import algosdk from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import { algo } from '../amount'
import { AlgorandClient } from './algorand-client'
import { AppClient } from './app-client'
import { isDTUnsupportedError } from './dt-support'
import { QueryRoundOutcome } from './query-manager'

// Live checks against a MainNet time-travel algod (dtalgod with EnableTimeTravel). Skipped unless DT_ALGOD_SERVER is set:
//
//   DT_ALGOD_SERVER=http://10.114.0.27:4000 npx vitest run src/types/dt.live.spec.ts
//
// DT_ALGOD_TOKEN sets the API token, if the node needs one.

const server = process.env.DT_ALGOD_SERVER

// MainNet objects with history
const USDC = 31566704n
const XGOV = 3147789458n
const XGOV_CREATOR = 'I7OP7WFSK57IFDHJA6DM5TJC2IFY4M3XSBV4R4PVOV4YWF7K57BZFUVQ5E'
/** A round before the xGov app existed, after USDC was created */
const PAST = 50_000_000n

/** Runs a test of a newer dtalgod feature, skipping it on a node that doesn't support it yet. */
const onNewerNode = (run: () => Promise<void>) => async (ctx: { skip: (note?: string) => void }) => {
  try {
    await run()
  } catch (error) {
    if (isDTUnsupportedError(error)) return ctx.skip(`the node does not support it: ${(error as Error).message}`)
    throw error
  }
}

describe.skipIf(!server)('time travel against a live dtalgod', { timeout: 60_000 }, () => {
  let algorand: AlgorandClient
  let latest: bigint
  /** On a dtalgod older than the simulate limits endpoint, its default limits, which utils can't know */
  let olderNode: { maxGroups?: number; maxRounds?: number }

  beforeAll(async () => {
    const url = new URL(server!)
    algorand = AlgorandClient.fromConfig({
      algodConfig: { server: `${url.protocol}//${url.hostname}`, port: url.port, token: process.env.DT_ALGOD_TOKEN ?? '' },
    })
    const { genesisId } = await algorand.client.network()
    if (genesisId !== 'mainnet-v1.0') throw new Error(`Expected a MainNet node, got ${genesisId}`)
    latest = (await algorand.client.algod.status().do()).lastRound
    olderNode = (await algorand.simulate.limits()).reported ? {} : { maxGroups: 16, maxRounds: 16 }
  })

  test('reports its simulate limits', async (ctx) => {
    const limits = await algorand.simulate.limits()
    if (!limits.reported) return ctx.skip('the node has no simulate limits endpoint')
    expect(limits.timeTravel).toBe(true)
    expect(limits.maxTxnGroups).toBeGreaterThanOrEqual(1)
    expect(limits.maxExtraOpcodeBudget).toBeGreaterThan(0)
  })

  test('supports time travel', async () => {
    expect(await algorand.dt.supported()).toBe(true)
  })

  test('global state at past rounds matches the app versions', async () => {
    const { versions } = await algorand.dt.getAppVersions(XGOV, { order: 'desc', limit: 3, includeValues: true })
    expect(versions.length).toBeGreaterThan(0)
    for (const v of versions.filter((v) => v.app)) {
      const state = await algorand.app.getGlobalState(XGOV, { round: v.round })
      expect(state).toEqual(v.app!.globalState)
    }
  })

  test('an app client pinned to a round reads that round', async () => {
    const { versions } = await algorand.dt.getAppVersions(XGOV, { order: 'desc', limit: 2, includeValues: true })
    const older = versions.at(-1)!
    const client = new AppClient({
      appId: XGOV,
      algorand,
      appSpec: {
        name: 'xgov',
        arcs: [],
        methods: [],
        structs: {},
        state: {
          keys: { global: {}, local: {}, box: {} },
          maps: { global: {}, local: {}, box: {} },
          schema: { global: { ints: 0, bytes: 0 }, local: { ints: 0, bytes: 0 } },
        },
        bareActions: { create: [], call: [] },
        source: { approval: '', clear: '' },
      } as never,
    })
    expect(await client.atRound(older.round).getGlobalState()).toEqual(older.app!.globalState)
  })

  test('box values at past rounds match the box change feed', async () => {
    const { versions } = await algorand.dt.getBoxesVersions(XGOV, { order: 'desc', limit: 3, includeValues: true })
    expect(versions.length).toBeGreaterThan(0)
    for (const v of versions) {
      for (const box of v.boxes.filter((b) => !b.deleted)) {
        const value = await algorand.app.getBoxValue(XGOV, box.name, { round: v.round })
        expect(Buffer.from(value).equals(Buffer.from(box.value!))).toBe(true)
      }
    }
  })

  test('asset and account reads at a past round', async () => {
    const usdc = await algorand.asset.getById(USDC, { round: PAST })
    expect(usdc.unitName).toBe('USDC')
    const creator = await algorand.account.getInformation(XGOV_CREATOR, { round: latest - 100n })
    expect(creator.validAsOfRound).toBe(latest - 100n)
    await expect(algorand.app.getById(XGOV, { round: PAST })).rejects.toThrow()
  })

  test('simulate groups in order and in parallel', async () => {
    const fresh = algosdk.generateAccount().addr
    const fund = algorand.newGroup().addPayment({ sender: XGOV_CREATOR, receiver: fresh, amount: algo(1) })
    const spend = algorand.newGroup().addPayment({ sender: fresh, receiver: XGOV_CREATOR, amount: algo(0.1) })

    const sequential = await algorand.simulate.groups([fund, spend], olderNode)
    expect(sequential.map((o) => o.ok)).toEqual([true, true])

    const parallel = await algorand.simulate.groups([fund, spend], { ...olderNode, parallel: true })
    expect(parallel[0].ok).toBe(true)
    expect(parallel[1].ok).toBe(false)
    if (!parallel[1].ok) expect(parallel[1].error.failureMessage).toMatch(/overspend/)
  })

  test('simulate at several rounds, packed into windows', async () => {
    const pay = algorand.newGroup().addPayment({ sender: XGOV_CREATOR, receiver: algosdk.generateAccount().addr, amount: algo(1) })
    const rounds = [latest - 2_000n, latest - 10n, latest - 1_500n, latest - 5n]
    const outcomes = await algorand.simulate.rounds(pay, rounds, olderNode)
    expect(outcomes.map((o) => o.round)).toEqual(rounds)
    for (const o of outcomes) {
      expect(o.groups).toHaveLength(1)
      expect(o.groups[0].round).toBe(o.round)
      expect(o.groups[0].ok).toBe(true)
    }
  })

  test(
    'simulate at rounds far apart with the validity window rewritten',
    onNewerNode(async () => {
      const pay = algorand.newGroup().addPayment({ sender: XGOV_CREATOR, receiver: algosdk.generateAccount().addr, amount: algo(1) })
      const rounds = [latest - 200_000n, latest - 5n]
      const outcomes = await algorand.simulate.rounds(pay, rounds, { ...olderNode, validityWindow: 'rewrite' })
      expect(outcomes.map((o) => [o.round, o.groups[0].ok])).toEqual(rounds.map((r) => [r, true]))
    }),
  )

  test(
    'simulate under a later protocol',
    onNewerNode(async () => {
      const pay = algorand.newGroup().addPayment({ sender: XGOV_CREATOR, receiver: algosdk.generateAccount().addr, amount: algo(1) })
      const [now] = await algorand.simulate.groups([pay], { round: latest - 5n, protocol: 'latest' })
      expect(now.protocolOverride).toMatchObject({ applied: false })
      expect(now.protocolOverride!.from).toBe(now.protocolOverride!.to)

      // Long before the latest protocol upgrade. The group may fail (the sender may not exist yet); the override is still there
      const [old] = await algorand.simulate.groups([pay], { round: 20_000_000n, protocol: 'latest' })
      expect(old.protocolOverride?.applied).toBe(true)
      expect(old.protocolOverride?.from).not.toBe(old.protocolOverride?.to)
      expect(old.protocolOverride?.to).toBe(now.protocolOverride!.to)
    }),
  )

  describe('query', () => {
    /** `#pragma version 10; global Round; itob; log; txn ApplicationArgs 0; log; int 1`, compiled by dtalgod's /v2/teal/compile */
    const ECHO = new Uint8Array(Buffer.from('CjIGFrA2GgCwgQE=', 'base64'))
    let supported: boolean

    beforeAll(async () => {
      supported = await algorand.query.supported()
    })

    const roundLog = (log: Uint8Array) => algosdk.decodeUint64(log, 'bigint')

    test('runs a program at several rounds, in one request or chunked', async (ctx) => {
      if (!supported) return ctx.skip('the node has no queries')
      const params = { program: ECHO, protocol: 'round', rounds: [0, PAST, PAST], calls: [{ args: [new TextEncoder().encode('hi')] }, {}] }
      const results = await algorand.query.run(params)
      expect(results).toHaveLength(3)
      expect(results[0].round).toBeGreaterThan(PAST)
      expect(results.slice(1).map((r) => r.round)).toEqual([PAST, PAST])
      for (const r of results) {
        expect(r.protocolOverride).toBeUndefined()
        const [hi, none] = r.calls
        expect(hi.ok).toBe(true)
        if (hi.ok) {
          expect(roundLog(hi.logs[0])).toBe(r.round + 1n)
          expect(new TextDecoder().decode(hi.logs[1])).toBe('hi')
          expect(hi.cost).toBeGreaterThan(0)
        }
        expect(none.ok).toBe(false)
        if (!none.ok) {
          expect(none.error).toMatchObject({ kind: 'call', callIndex: 1 })
          expect(none.error.failureMessage).toMatch(/^logic eval error: invalid ApplicationArgs index 0/)
          expect(none.error.logs.map(roundLog)).toEqual([r.round + 1n])
        }
      }
      // One call and one round per request: the same results, with the latest round pinned
      const chunked = await algorand.query.run(params, { maxCalls: 1, maxRounds: 1 })
      expect(chunked.slice(1)).toEqual(results.slice(1))
      expect(chunked[0].round).toBeGreaterThanOrEqual(results[0].round)
    })

    test('calls a deployed app at the latest round and before it existed', async (ctx) => {
      if (!supported) return ctx.skip('the node has no queries')
      const [now] = await algorand.query.run({ appId: XGOV, calls: [{}] })
      expect(now.round).toBeGreaterThanOrEqual(latest)
      expect(now.calls).toHaveLength(1)
      // Before the app existed: a failed call or round, not a thrown error
      const [before] = await algorand.query.run({ appId: XGOV, rounds: [PAST], calls: [{}] })
      expect(before.round).toBe(PAST)
      expect(before.calls[0].ok).toBe(false)
    })

    /** `#pragma version 10; global Round; itob; log; byte 0x151f7c75; global Round; itob; concat; log; int 1`: returns the round of its block */
    const ROUND_ABI = new Uint8Array(Buffer.from('CjIGFrCABBUffHUyBhZQsIEB', 'base64'))
    /** `#pragma version 10; int 1` */
    const CLEAR = new Uint8Array(Buffer.from('CoEB', 'base64'))
    const FEE_SINK = 'Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA'
    const roundMethod = algosdk.ABIMethod.fromSignature('round()uint64')
    const roundCall = () =>
      algorand
        .newGroup()
        .addAppCreateMethodCall({ sender: FEE_SINK, method: roundMethod, args: [], approvalProgram: ROUND_ABI, clearStateProgram: CLEAR })
    /** Per round, per group: the via, the logs and the return value of each outcome */
    const summary = (results: QueryRoundOutcome[]) =>
      results.map((r) => [
        r.round,
        r.groups.map((g) =>
          g.ok
            ? [g.via, g.txns.map((t) => t.logs.map((l) => Buffer.from(l).toString('hex'))), g.returns.map((x) => x.returnValue)]
            : g.error.message,
        ),
      ])

    test('composed calls give the same results through query and simulate', async (ctx) => {
      if (!supported) return ctx.skip('the node has no queries')
      const rounds = [PAST, PAST + 5_000n]
      const queried = await algorand.query.rounds(roundCall(), rounds, { via: 'query' })
      const simulated = await algorand.query.rounds(roundCall(), rounds, { via: 'simulate', validityWindow: 'rewrite' })
      expect(queried.map((r) => r.groups[0].via)).toEqual(['query', 'query'])
      expect(simulated.map((r) => r.groups[0].via)).toEqual(['simulate', 'simulate'])
      const strip = (s: ReturnType<typeof summary>) => s.map(([round, groups]) => [round, (groups as unknown[][]).map((g) => g.slice(1))])
      expect(strip(summary(queried))).toEqual(strip(summary(simulated)))
      for (const r of queried) {
        const g = r.groups[0]
        expect(g.ok && g.returns[0].returnValue).toBe(r.round + 1n)
      }
      const outcomes = await algorand.query.groups([roundCall(), roundCall()], { via: 'query' })
      expect(outcomes.map((o) => [o.via, o.ok, o.round])).toEqual([
        ['query', true, outcomes[0].round],
        ['query', true, outcomes[0].round],
      ])
      expect(outcomes[0].round).toBeGreaterThanOrEqual(latest)
    })

    test('composed calls fall back to simulate on a node without queries', async (ctx) => {
      if (supported) return ctx.skip('the node has queries')
      const rounds = [PAST, PAST + 5_000n]
      const results = await algorand.query.rounds(roundCall(), rounds, { validityWindow: 'rewrite' })
      expect(results.map((r) => r.groups[0].via)).toEqual(['simulate', 'simulate'])
      for (const r of results) {
        const g = r.groups[0]
        expect(g.ok && g.returns[0].returnValue).toBe(r.round + 1n)
      }
      await expect(algorand.query.rounds(roundCall(), rounds, { via: 'query' })).rejects.toThrow()
    })

    test('a node without queries throws DTUnsupportedError', async (ctx) => {
      if (supported) return ctx.skip('the node has queries')
      expect(await algorand.query.limits()).toBeUndefined()
      expect(isDTUnsupportedError(await algorand.query.run({ program: ECHO, calls: [{}] }).catch((e) => e))).toBe(true)
    })
  })
})
