import algosdk from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import { algo } from '../amount'
import { AlgorandClient } from './algorand-client'
import { AppClient } from './app-client'
import { isDTUnsupportedError } from './dt-support'

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
})
