import algosdk from 'algosdk'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { algo, microAlgo } from '../amount'
import stateArc56 from '../../tests/example-contracts/state/State.arc56.json'
import boxMapArc56 from '../../tests/example-contracts/box_map/artifacts/BoxMapTest.arc56.json'
import { AlgorandClient } from './algorand-client'
import { AppClient } from './app-client'
import { DTAlgodLike, DTNotAvailableError, isDTUnsupportedError } from './dt-support'
import { QueryCallError, QueryCallOutcome, QueryGroupError, QueryGroupOutcome, QueryGroupsOptions } from './query-manager'
import { TransactionComposer } from './composer'
import modelsv2 = algosdk.modelsv2

// Offline tests of the time travel and extended simulate features, against a stub algod.

type Call = { method: 'get' | 'post'; path: string; query: Record<string, string>; body?: Uint8Array; options?: Record<string, unknown> }
type Answer = { status: number; json?: unknown; body?: Uint8Array }
type Route = { method: 'get' | 'post'; path: string | RegExp; answer: (call: Call) => Answer | Promise<Answer> }

/** A BaseHTTPClient that answers from routes, in the order they were added; a route answers once unless `repeat`. */
class StubClient implements algosdk.BaseHTTPClient {
  calls: Call[] = []
  private routes: (Route & { repeat: boolean })[] = []

  on(method: 'get' | 'post', path: string | RegExp, answer: (call: Call) => Answer | Promise<Answer>, repeat = false) {
    this.routes.push({ method, path, answer, repeat })
    return this
  }

  private async answer(call: Call): Promise<algosdk.BaseHTTPClientResponse> {
    this.calls.push(call)
    const i = this.routes.findIndex(
      (r) => r.method === call.method && (typeof r.path === 'string' ? r.path === call.path : r.path.test(call.path)),
    )
    if (i < 0) throw new Error(`unexpected request ${call.method} ${call.path}`)
    const route = this.routes[i]
    if (!route.repeat) this.routes.splice(i, 1)
    const { status, json, body } = await route.answer(call)
    const response = { body: body ?? new TextEncoder().encode(JSON.stringify(json)), status, headers: {} }
    if (status >= 300) {
      const { message } = (json ?? {}) as { message?: string }
      throw Object.assign(new Error(`Network request error. Received status ${status} (Bad Request)${message ? `: ${message}` : ''}`), {
        response,
        status,
      })
    }
    return response
  }

  async get(path: string, query?: Record<string, string>, _headers?: Record<string, string>, options?: Record<string, unknown>) {
    return this.answer({ method: 'get', path, query: { ...(query ?? {}) }, options })
  }

  async post(
    path: string,
    data: Uint8Array,
    query?: Record<string, string>,
    _headers?: Record<string, string>,
    options?: Record<string, unknown>,
  ) {
    return this.answer({ method: 'post', path, query: { ...(query ?? {}) }, body: data, options })
  }

  delete(): Promise<algosdk.BaseHTTPClientResponse> {
    throw new Error('not implemented')
  }
}

const json = (body: unknown) => () => ({ status: 200, json: body })
const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64')

const LAST_ROUND = 50_000
const GENESIS_HASH = b64(new Uint8Array(32).fill(7))
const suggestedParams = json({
  'consensus-version': 'future',
  fee: 0,
  'genesis-hash': GENESIS_HASH,
  'genesis-id': 'testnet-v1.0',
  'last-round': LAST_ROUND,
  'min-fee': 1000,
})

const accountJson = (address: string, round: number, amount = 1_000_000) => ({
  address,
  amount,
  'amount-without-pending-rewards': amount,
  'min-balance': 100_000,
  'pending-rewards': 0,
  rewards: 0,
  round,
  status: 'Offline',
  'total-apps-opted-in': 0,
  'total-assets-opted-in': 0,
  'total-created-apps': 0,
  'total-created-assets': 0,
})

const appJson = (id: number, creator: string, counter: number) => ({
  id,
  params: {
    creator,
    'approval-program': b64(new Uint8Array([10, 129, 1])),
    'clear-state-program': b64(new Uint8Array([10, 129, 1])),
    'global-state': [{ key: b64('int1'), value: { type: 2, uint: counter, bytes: '' } }],
    'global-state-schema': { 'num-uint': 1, 'num-byte-slice': 0 },
  },
})

const nodeStatus = json({
  'catchup-time': 0,
  'last-round': LAST_ROUND,
  'last-version': 'future',
  'next-version': 'future',
  'next-version-round': LAST_ROUND + 1,
  'next-version-supported': true,
  'stopped-at-unsupported-round': false,
  'time-since-last-round': 0,
})

/** Answers the time travel probe (`supportsDT`) as a time-travel node. */
const probeOk = (stub: StubClient) => stub.on('get', '/v2/applications/0/box/versions', json({ round: LAST_ROUND, versions: [] }), true)

/** dtalgod's default simulate limits, as its limits endpoint answers them. */
const LIMITS = {
  'max-txn-groups': 16,
  'max-rounds': 16,
  'max-extra-opcode-budget': 320_000,
  'resource-limit-multiplier': 1,
  'time-travel': true,
  'developer-api': false,
}

/** Answers the simulate limits endpoint as dtalgod with these limits. */
const limitsOk = (stub: StubClient, limits: Partial<typeof LIMITS> = {}) =>
  stub.on('get', '/v2/transactions/simulate/limits', json({ ...LIMITS, ...limits }), true)

/** Answers the simulate limits endpoint with a 404, as stock algod or an older dtalgod. */
const limits404 = (stub: StubClient) =>
  stub.on('get', '/v2/transactions/simulate/limits', () => ({ status: 404, json: { message: 'Not Found' } }), true)

const limitsCalls = (stub: StubClient) => stub.calls.filter((c) => c.path === '/v2/transactions/simulate/limits')

/** Runs `run` with the fork's `DTAlgodClient.features` lacking `without`, as an older version of the fork. */
const withoutFeatures = async (without: string[], run: () => Promise<void>) => {
  const DT = algosdk.DTAlgodClient as unknown as { features: readonly string[] }
  const features = DT.features
  Object.defineProperty(DT, 'features', { value: features.filter((f) => !without.includes(f)), configurable: true, writable: true })
  try {
    await run()
  } finally {
    Object.defineProperty(DT, 'features', { value: features, configurable: true, writable: true })
  }
}

const sentSimulate = (call: Call) =>
  algosdk.decodeMsgpack(
    call.body!,
    (algosdk as unknown as { dtModels: { DTSimulateRequest: never } }).dtModels.DTSimulateRequest,
  ) as modelsv2.SimulateRequest & {
    parallelGroups?: boolean
    rounds?: bigint[]
    skipValidityWindow?: boolean
    rewriteValidityWindow?: boolean
    protocol?: string
  }

/**
 * A simulate answer with one successful result per transaction, or per round with `rounds`, logging `log(txn)`. It echoes
 * the validity window modes, and with `protocol` has a protocol override with a note on the request's first group.
 * `roundError` fails a round of `rounds`.
 */
const echoSimulate =
  (
    log?: (txn: algosdk.Transaction) => Uint8Array | undefined,
    fail?: (groupIndex: number) => string | undefined,
    roundError?: (round: bigint, request: ReturnType<typeof sentSimulate>) => string | undefined,
  ) =>
  (call: Call) => {
    const request = sentSimulate(call)
    const groups = (lastRound: bigint) =>
      request.txnGroups.map(
        (g, gi) =>
          new modelsv2.SimulateTransactionGroupResult({
            txnResults: g.txns.map(
              (stxn) =>
                new modelsv2.SimulateTransactionResult({
                  txnResult: new modelsv2.PendingTransactionResponse({
                    txn: stxn,
                    poolError: '',
                    logs: log?.(stxn.txn) ? [log(stxn.txn)!] : undefined,
                    confirmedRound: lastRound + 1n,
                  }),
                }),
            ),
            failureMessage: fail?.(gi),
            failedAt: fail?.(gi) ? [0] : undefined,
          }),
      )
    const tt = (algosdk as unknown as { dtModels: Record<string, new (args: unknown) => object> }).dtModels
    const { skipValidityWindow, rewriteValidityWindow, protocol } = request
    const evalOverrides =
      skipValidityWindow || rewriteValidityWindow
        ? new tt.DTSimulationEvalOverrides({ skipValidityWindow, rewriteValidityWindow })
        : undefined
    const protocolOverride = protocol
      ? new tt.SimulateProtocolOverride({
          from: 'v38',
          to: protocol === 'latest' ? 'v42' : protocol,
          applied: true,
          notes: [
            new tt.SimulateProtocolNote({ code: 'semantics-changed', message: 'MinTxnFee: 1000 → 1000' }),
            new tt.SimulateProtocolNote({
              code: 'block-incentive-fields',
              message: 'block read an incentive field of a round without incentives',
              hits: [new tt.SimulateProtocolNoteHit({ group: 0, path: [0] })],
            }),
          ],
        })
      : undefined
    const response = request.rounds?.length
      ? new tt.DTSimulateResponse({
          lastRound: 0,
          version: 2,
          txnGroups: [],
          evalOverrides,
          roundResults: request.rounds.map((r) =>
            roundError?.(r, request)
              ? new tt.SimulateRoundResult({ lastRound: r, txnGroups: [], error: roundError(r, request) })
              : new tt.SimulateRoundResult({ lastRound: r, txnGroups: groups(r), protocolOverride }),
          ),
        })
      : protocolOverride
        ? new tt.DTSimulateResponse({
            lastRound: request.round ?? LAST_ROUND,
            version: 2,
            txnGroups: groups(BigInt(request.round ?? LAST_ROUND)),
            protocolOverride,
          })
        : new modelsv2.SimulateResponse({
            lastRound: request.round ?? LAST_ROUND,
            version: 2,
            txnGroups: groups(BigInt(request.round ?? LAST_ROUND)),
          })
    return { status: 200, body: algosdk.encodeMsgpack(response as algosdk.Encodable) }
  }

/** An ABI return log of a uint64. */
const uint64Return = (value: bigint) => new Uint8Array([0x15, 0x1f, 0x7c, 0x75, ...algosdk.encodeUint64(value)])

describe('time travel', () => {
  let stub: StubClient
  let algorand: AlgorandClient
  const sender = algosdk.generateAccount().addr
  const address = sender.toString()

  beforeEach(() => {
    stub = new StubClient()
    algorand = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(stub, '') })
  })

  test('the fork client is shaped like DTAlgodLike', () => {
    const client: DTAlgodLike = new algosdk.DTAlgodClient('', 'http://localhost')
    expect(client).toBeDefined()
    expect(client.query).toBeTypeOf('function')
  })

  describe('reads at a round', () => {
    test('reads without a round are unchanged', async () => {
      stub.on('get', `/v2/accounts/${address}`, json(accountJson(address, LAST_ROUND)))
      const info = await algorand.account.getInformation(address)
      expect(info.validAsOfRound).toBe(BigInt(LAST_ROUND))
      expect(stub.calls[0].query.round).toBeUndefined()
    })

    test('account information at a round', async () => {
      stub.on('get', `/v2/accounts/${address}`, json(accountJson(address, 1234, 5)))
      const info = await algorand.account.getInformation(address, { round: 1234 })
      expect(stub.calls[0].query.round).toBe('1234')
      expect(info.validAsOfRound).toBe(1234n)
      expect(info.balance.microAlgo).toBe(5n)
    })

    test('a node that answers for another round throws instead of returning the latest state', async () => {
      stub.on('get', `/v2/accounts/${address}`, json(accountJson(address, LAST_ROUND)))
      const error = await algorand.account.getInformation(address, { round: 1234 }).catch((e) => e)
      expect(isDTUnsupportedError(error)).toBe(true)
    })

    test('asset holding at a round', async () => {
      stub.on(
        'get',
        `/v2/accounts/${address}/assets/77`,
        json({ round: 99, 'asset-holding': { amount: 42, 'asset-id': 77, 'is-frozen': false } }),
      )
      const holding = await algorand.asset.getAccountInformation(address, 77n, { round: 99 })
      expect(stub.calls[0].query.round).toBe('99')
      expect(holding).toMatchObject({ balance: 42n, round: 99n })
    })

    test('global state at a round checks the node supports time travel first', async () => {
      probeOk(stub).on('get', '/v2/applications/123', json(appJson(123, address, 5)))
      const state = await algorand.app.getGlobalState(123n, { round: 1000n })
      expect(state.int1.value).toBe(5n)
      expect(stub.calls.map((c) => c.path)).toEqual(['/v2/applications/0/box/versions', '/v2/applications/123'])
      expect(stub.calls[1].query.round).toBe('1000')
    })

    test('global state at a round on a node without time travel throws', async () => {
      stub.on('get', '/v2/applications/0/box/versions', () => ({ status: 404, json: { message: 'Not Found' } }))
      const error = await algorand.app.getGlobalState(123n, { round: 1000n }).catch((e) => e)
      expect(isDTUnsupportedError(error)).toBe(true)
      expect(stub.calls).toHaveLength(1)
    })

    test('box names at a round follow the pages', async () => {
      stub
        .on('get', '/v2/applications/5/boxes', (call) => {
          expect(call.query.next).toBeUndefined()
          return { status: 200, json: { round: 70, boxes: [{ name: b64('a') }], 'next-token': 'b64:YQ==' } }
        })
        .on('get', '/v2/applications/5/boxes', (call) => {
          expect(call.query.next).toBe('b64:YQ==')
          return { status: 200, json: { round: 70, boxes: [{ name: b64('b') }] } }
        })
      const names = await algorand.app.getBoxNames(5n, { round: 70 })
      expect(names.map((n) => n.name)).toEqual(['a', 'b'])
      expect(stub.calls.every((c) => c.query.round === '70')).toBe(true)
    })

    test('box value at a round', async () => {
      stub.on('get', '/v2/applications/5/box', json({ round: 70, name: b64('a'), value: b64('hello') }))
      const value = await algorand.app.getBoxValue(5n, 'a', { round: 70 })
      expect(Buffer.from(value).toString()).toBe('hello')
      expect(stub.calls[0].query).toMatchObject({ name: `b64:${b64('a')}`, round: '70' })
    })

    test('a signal goes to fetch for reads at a round and at the latest round', async () => {
      const { signal } = new AbortController()
      stub.on('get', '/v2/applications/5/box', json({ round: 70, name: b64('a'), value: b64('hello') }), true)
      await algorand.app.getBoxValue(5n, 'a', { round: 70, signal })
      await algorand.app.getBoxValue(5n, 'a', { signal })
      expect(stub.calls.map((c) => c.options?.signal)).toEqual([signal, signal])
    })

    test('without the time-travel fork of algosdk, reads at a round throw and other reads still work', async () => {
      const TT = algosdk.DTAlgodClient as unknown as { features: readonly string[] }
      const features = TT.features
      Object.defineProperty(TT, 'features', { value: [], configurable: true, writable: true })
      try {
        await expect(algorand.account.getInformation(address, { round: 1 })).rejects.toThrow(DTNotAvailableError)
        await expect(algorand.dt.getAppVersions(1n)).rejects.toThrow(DTNotAvailableError)
        expect(await algorand.dt.supported()).toBe(false)
        stub.on('get', `/v2/accounts/${address}`, json(accountJson(address, LAST_ROUND)))
        expect((await algorand.account.getInformation(address)).validAsOfRound).toBe(BigInt(LAST_ROUND))
      } finally {
        Object.defineProperty(TT, 'features', { value: features, configurable: true, writable: true })
      }
    })
  })

  describe('versions', () => {
    test('a page of box versions passes the options', async () => {
      stub.on(
        'get',
        '/v2/applications/5/box/versions',
        json({
          round: 900,
          versions: [{ round: 800, timestamp: 1700000000, deleted: false, value: b64('v1') }],
          'next-token': '801',
        }),
      )
      const page = await algorand.dt.getBoxVersions(5n, 'counter', {
        minRound: 10,
        maxRound: 900n,
        order: 'desc',
        limit: 1,
        includeValues: true,
        next: '700',
      })
      expect(stub.calls[0].query).toMatchObject({
        name: `b64:${b64('counter')}`,
        'min-round': '10',
        'max-round': '900',
        order: 'desc',
        limit: '1',
        include: 'values',
        next: '700',
      })
      expect(page.round).toBe(900n)
      expect(page.nextToken).toBe('801')
      expect(page.versions).toHaveLength(1)
      expect(page.versions[0]).toMatchObject({ round: 800n, deleted: false })
      expect(Buffer.from(page.versions[0].value!).toString()).toBe('v1')
    })

    test('iterating follows the pages', async () => {
      stub
        .on(
          'get',
          '/v2/applications/5/boxes/versions',
          json({ round: 900, versions: [{ round: 1, timestamp: 1, boxes: [{ name: b64('a'), deleted: false }] }], 'next-token': '2' }),
        )
        .on(
          'get',
          '/v2/applications/5/boxes/versions',
          json({ round: 900, versions: [{ round: 3, timestamp: 2, boxes: [{ name: b64('b'), deleted: true }] }] }),
        )
      const versions = []
      for await (const v of algorand.dt.iterateBoxesVersions(5n)) versions.push(v)
      expect(versions.map((v) => [v.round, v.boxes[0].name.name, v.boxes[0].deleted])).toEqual([
        [1n, 'a', false],
        [3n, 'b', true],
      ])
      expect(stub.calls[1].query.next).toBe('2')
    })

    test('iterating passes the signal on every page, and an abort stops it without more requests', async () => {
      const boxesPage = (round: number, next?: string) =>
        json({
          round: 900,
          versions: [round, round + 1].map((r) => ({ round: r, timestamp: r, boxes: [{ name: b64('a'), deleted: false }] })),
          ...(next ? { 'next-token': next } : {}),
        })
      stub.on('get', '/v2/applications/5/boxes/versions', boxesPage(1, '3')).on('get', '/v2/applications/5/boxes/versions', boxesPage(3))
      const controller = new AbortController()
      const rounds = []
      for await (const v of algorand.dt.iterateBoxesVersions(5n, { signal: controller.signal })) rounds.push(v.round)
      expect(rounds).toEqual([1n, 2n, 3n, 4n])
      expect(stub.calls.map((c) => c.options?.signal)).toEqual([controller.signal, controller.signal])

      // Aborted while holding the first entry of a page that has a next page
      stub.calls = []
      stub.on('get', '/v2/applications/5/boxes/versions', boxesPage(1, '3'), true)
      const reason = new Error('navigated away')
      const aborting = new AbortController()
      const seen: bigint[] = []
      await expect(
        (async () => {
          for await (const v of algorand.dt.iterateBoxesVersions(5n, { signal: aborting.signal })) {
            seen.push(v.round)
            aborting.abort(reason)
          }
        })(),
      ).rejects.toBe(reason)
      expect(seen).toEqual([1n])
      expect(stub.calls).toHaveLength(1)

      // Aborted before it starts: no request at all
      stub.calls = []
      await expect(algorand.dt.iterateAppVersions(5n, { signal: aborting.signal }).next()).rejects.toBe(reason)
      expect(stub.calls).toHaveLength(0)
    })

    test('app versions decode global state', async () => {
      stub.on(
        'get',
        '/v2/applications/123/versions',
        json({
          round: 900,
          versions: [
            { round: 10, timestamp: 1, deleted: false, application: appJson(123, address, 1) },
            { round: 20, timestamp: 2, deleted: true },
          ],
        }),
      )
      const page = await algorand.dt.getAppVersions(123n, { includeValues: true })
      expect(page.nextToken).toBeUndefined()
      expect(page.versions[0].app?.globalState.int1.value).toBe(1n)
      expect(page.versions[1]).toMatchObject({ round: 20n, deleted: true, app: undefined })
    })

    test('account versions pass exclude and map the base account', async () => {
      stub.on(
        'get',
        `/v2/accounts/${address}/versions`,
        json({
          round: 900,
          versions: [
            {
              round: 10,
              timestamp: 1,
              base: { deleted: false, account: accountJson(address, 10, 77) },
              assets: [{ 'asset-id': 9, deleted: false, 'asset-holding': { amount: 3, 'asset-id': 9, 'is-frozen': true } }],
            },
          ],
        }),
      )
      const page = await algorand.dt.getAccountVersions(address, { exclude: ['created-apps-params'], includeValues: true })
      expect(stub.calls[0].query.exclude).toBe('created-apps-params')
      expect(page.versions[0].base?.account?.balance.microAlgo).toBe(77n)
      expect(page.versions[0].assets).toEqual([{ assetId: 9n, deleted: false, holding: { balance: 3n, frozen: true } }])
    })

    describe('as of rounds', () => {
      /**
       * Answers a rounds request with one asset entry per requested round from `next` on, `limit` (or `pageSize`) at a
       * time; round 1000 did not exist.
       */
      const roundsEcho =
        (pageSize?: number) =>
        (call: Call): Answer => {
          const rounds = call.query.rounds.split(',').map(BigInt)
          const start = call.query.next ? rounds.indexOf(BigInt(call.query.next)) : 0
          const size = pageSize ?? Number(call.query.limit ?? 100)
          const taken = rounds.slice(start, start + size)
          const rest = rounds[start + size]
          return {
            status: 200,
            json: {
              round: LAST_ROUND,
              versions: taken.map((r) =>
                r === 1000n
                  ? { round: Number(r), timestamp: 1, deleted: true }
                  : { round: Number(r), timestamp: 2, deleted: false, 'changed-round': 77 },
              ),
              ...(rest !== undefined ? { 'next-token': rest.toString() } : {}),
            },
          }
        }
      const sentRounds = () => stub.calls.map((c) => c.query.rounds.split(',').map(Number))

      test('a page sends the rounds as given, and maps changedRound; deleted without changedRound means it did not exist', async () => {
        stub.on('get', '/v2/assets/9/versions', roundsEcho())
        const page = await algorand.dt.getAssetVersions(9n, { rounds: [2000, 1000n, 0], limit: 5 })
        expect(stub.calls[0].query).toMatchObject({ rounds: '2000,1000,0', limit: '5' })
        expect(stub.calls[0].query['min-round']).toBeUndefined()
        expect(page.versions.map((v) => [v.round, v.deleted, v.changedRound])).toEqual([
          [2000n, false, 77n],
          [1000n, true, undefined],
          [0n, false, 77n],
        ])
      })

      test('iterators dedupe and sort the rounds, and split them into requests of min(limit, 500)', async () => {
        stub.on('get', '/v2/assets/9/versions', roundsEcho(), true)
        const rounds = Array.from({ length: 1200 }, (_, i) => 1_000_000 + i).reverse()
        const seen: bigint[] = []
        for await (const v of algorand.dt.iterateAssetVersions(9n, { rounds: [...rounds, rounds[3]], limit: 1000 })) seen.push(v.round)
        expect(sentRounds().map((r) => r.length)).toEqual([500, 500, 200])
        expect(seen).toEqual([...rounds].sort((a, b) => a - b).map(BigInt))

        stub.calls = []
        const desc: bigint[] = []
        for await (const v of algorand.dt.iterateAssetVersions(9n, { rounds: rounds.slice(0, 250), order: 'desc' })) desc.push(v.round)
        expect(sentRounds().map((r) => r.length)).toEqual([100, 100, 50])
        expect(stub.calls[0].query.order).toBe('desc')
        expect(desc).toEqual(rounds.slice(0, 250).map(BigInt))

        stub.calls = []
        for await (const _ of algorand.dt.iterateAssetVersions(9n, { rounds: rounds.slice(0, 10), maxRoundsPerRequest: 4 })) void _
        expect(sentRounds().map((r) => r.length)).toEqual([4, 4, 2])
      })

      test('a chunk is paged to its end before the next chunk starts', async () => {
        stub.on('get', '/v2/assets/9/versions', roundsEcho(2), true)
        const seen: bigint[] = []
        for await (const v of algorand.dt.iterateAssetVersions(9n, { rounds: [5, 1, 4, 2, 3], limit: 3 })) seen.push(v.round)
        expect(seen).toEqual([1n, 2n, 3n, 4n, 5n])
        expect(stub.calls.map((c) => [c.query.rounds, c.query.next])).toEqual([
          ['1,2,3', undefined],
          ['1,2,3', '3'],
          ['4,5', undefined],
        ])
      })

      test('checks: no requests for an empty list in an iterator, errors for a page and for minRound', async () => {
        const none = []
        for await (const v of algorand.dt.iterateAssetVersions(9n, { rounds: [] })) none.push(v)
        expect(none).toEqual([])
        expect(stub.calls).toHaveLength(0)
        await expect(algorand.dt.getAssetVersions(9n, { rounds: [] })).rejects.toThrow(/at least one round/)
        await expect(algorand.dt.getAssetVersions(9n, { rounds: [5], minRound: 1 })).rejects.toThrow(/minRound or maxRound/)
        await expect(algorand.dt.iterateAssetVersions(9n, { rounds: [5], maxRound: 9 }).next()).rejects.toThrow(/minRound or maxRound/)
        await expect(algorand.dt.iterateAssetVersions(9n, { rounds: [5], maxRoundsPerRequest: 0 }).next()).rejects.toThrow(
          /maxRoundsPerRequest/,
        )
        expect(stub.calls).toHaveLength(0)
      })

      test('an older fork without versions-rounds or versions-keys throws DTNotAvailableError', async () => {
        await withoutFeatures(['versions-rounds', 'versions-keys'], async () => {
          await expect(algorand.dt.getAssetVersions(9n, { rounds: [5] })).rejects.toThrow(DTNotAvailableError)
          await expect(algorand.dt.getAppVersions(9n, { includeKeys: true })).rejects.toThrow(/versions-keys/)
        })
        expect(stub.calls).toHaveLength(0)
      })

      test('changedRound on every type, account sub-objects included', async () => {
        stub
          .on(
            'get',
            '/v2/applications/5/box/versions',
            json({ round: 900, versions: [{ round: 10, timestamp: 1, deleted: false, 'changed-round': 8 }] }),
          )
          .on(
            'get',
            '/v2/applications/5/boxes/versions',
            json({ round: 900, versions: [{ round: 10, timestamp: 1, boxes: [{ name: b64('a'), deleted: false, 'changed-round': 7 }] }] }),
          )
          .on(
            'get',
            '/v2/applications/5/versions',
            json({ round: 900, versions: [{ round: 10, timestamp: 1, deleted: false, 'changed-round': 6 }] }),
          )
          .on(
            'get',
            `/v2/accounts/${address}/versions`,
            json({
              round: 900,
              versions: [
                {
                  round: 10,
                  timestamp: 1,
                  base: { deleted: false, 'changed-round': 1 },
                  assets: [{ 'asset-id': 9, deleted: false, 'changed-round': 2 }],
                  'apps-local-state': [{ 'app-id': 5, deleted: false, 'changed-round': 3 }],
                  'created-assets': [{ 'asset-id': 9, deleted: false, 'changed-round': 4 }],
                  'created-apps': [{ 'app-id': 5, deleted: false, 'changed-round': 5 }],
                },
              ],
            }),
          )
        expect((await algorand.dt.getBoxVersions(5n, 'a', { rounds: [10] })).versions[0].changedRound).toBe(8n)
        expect((await algorand.dt.getBoxesVersions(5n, { rounds: [10] })).versions[0].boxes[0].changedRound).toBe(7n)
        expect((await algorand.dt.getAppVersions(5n, { rounds: [10] })).versions[0].changedRound).toBe(6n)
        const [account] = (await algorand.dt.getAccountVersions(address, { rounds: [10] })).versions
        expect([
          account.base?.changedRound,
          account.assets?.[0].changedRound,
          account.appsLocalState?.[0].changedRound,
          account.createdAssets?.[0].changedRound,
          account.createdApps?.[0].changedRound,
        ]).toEqual([1n, 2n, 3n, 4n, 5n])
      })
    })

    test('includeKeys sends include=values,keys and maps changedKeys, keeping [] apart from absent', async () => {
      stub
        .on(
          'get',
          '/v2/applications/5/versions',
          json({
            round: 900,
            versions: [
              { round: 10, timestamp: 1, deleted: false, 'changed-keys': [b64('b'), b64('a')] },
              { round: 11, timestamp: 1, deleted: false, 'changed-keys': [] },
              { round: 12, timestamp: 1, deleted: true },
            ],
          }),
        )
        .on(
          'get',
          `/v2/accounts/${address}/applications/5/versions`,
          json({
            round: 900,
            versions: [
              {
                round: 10,
                timestamp: 1,
                'apps-local-state': [{ 'app-id': 5, deleted: false, 'changed-keys': [b64('l')] }],
                'created-apps': [{ 'app-id': 5, deleted: false, 'changed-keys': [] }],
              },
            ],
          }),
        )
      const page = await algorand.dt.getAppVersions(5n, { includeKeys: true, includeValues: true })
      expect(stub.calls[0].query.include).toBe('values,keys')
      expect(page.versions.map((v) => v.changedKeys?.map((k) => Buffer.from(k).toString()))).toEqual([['b', 'a'], [], undefined])
      const [local] = (await algorand.dt.getAccountAppVersions(address, 5n, { includeKeys: true })).versions
      expect(stub.calls[1].query.include).toBe('keys')
      expect(local.appsLocalState?.[0].changedKeys?.map((k) => Buffer.from(k).toString())).toEqual(['l'])
      expect(local.createdApps?.[0].changedKeys).toEqual([])
    })

    describe('key and prefix filters', () => {
      const tv = (v: number | string) => (typeof v === 'number' ? { type: 2, uint: v, bytes: '' } : { type: 1, uint: 0, bytes: b64(v) })

      test('key=b64:… is sent as given and keyValue decoded; a short page keeps its nextToken', async () => {
        stub
          .on(
            'get',
            '/v2/applications/5/versions',
            json({
              round: 900,
              versions: [
                { round: 10, timestamp: 1, deleted: false, 'key-value': tv(7) },
                { round: 11, timestamp: 1, deleted: false, 'key-value': tv('hi') },
                { round: 12, timestamp: 1, deleted: false },
              ],
              'next-token': '13',
            }),
          )
          .on(
            'get',
            `/v2/accounts/${address}/applications/5/versions`,
            json({
              round: 900,
              versions: [{ round: 10, timestamp: 1, 'apps-local-state': [{ 'app-id': 5, deleted: false, 'key-value': tv(3) }] }],
            }),
          )
        const page = await algorand.dt.getAppVersions(5n, { key: 'total', limit: 5000 })
        expect(stub.calls[0].query).toMatchObject({ key: `b64:${b64('total')}`, limit: '5000' })
        expect(stub.calls[0].query.include).toBeUndefined()
        expect(page.versions.map((v) => v.keyValue?.value)).toEqual([7n, 'hi', undefined])
        expect(page.versions[0].keyValue?.keyBase64).toBe(b64('total'))
        expect(page.nextToken).toBe('13')
        const local = await algorand.dt.getAccountAppVersions(address, 5n, { key: new Uint8Array([0, 1]) })
        expect(stub.calls[1].query.key).toBe('b64:AAE=')
        expect(local.versions[0].appsLocalState?.[0].keyValue?.value).toBe(3n)
        // No other request: nothing is probed
        expect(stub.calls).toHaveLength(2)
      })

      test('the iterators page through short and empty pages until there is no nextToken', async () => {
        stub
          .on('get', '/v2/applications/5/versions', json({ round: 900, versions: [], 'next-token': '100' }))
          .on(
            'get',
            '/v2/applications/5/versions',
            json({ round: 900, versions: [{ round: 150, timestamp: 1, deleted: false, 'key-value': tv(1) }], 'next-token': '200' }),
          )
          .on('get', '/v2/applications/5/versions', json({ round: 900, versions: [] }))
        const seen = []
        for await (const v of algorand.dt.iterateAppVersions(5n, { key: 'k' })) seen.push(v.round)
        expect(seen).toEqual([150n])
        expect(stub.calls.map((c) => [c.query.key, c.query.next])).toEqual([
          [`b64:${b64('k')}`, undefined],
          [`b64:${b64('k')}`, '100'],
          [`b64:${b64('k')}`, '200'],
        ])
      })

      test('prefix=b64:… is sent, with rounds too; an empty prefix sends nothing', async () => {
        const feed = json({ round: 900, versions: [{ round: 10, timestamp: 1, boxes: [{ name: b64('spsA'), deleted: false }] }] })
        stub.on('get', '/v2/applications/5/boxes/versions', feed, true)
        const page = await algorand.dt.getBoxesVersions(5n, { prefix: 'sps' })
        expect(stub.calls[0].query.prefix).toBe(`b64:${b64('sps')}`)
        expect(page.versions[0].boxes[0].name.name).toBe('spsA')
        for await (const _ of algorand.dt.iterateBoxesVersions(5n, { prefix: 'sps', rounds: [10] })) void _
        expect(stub.calls[1].query).toMatchObject({ prefix: `b64:${b64('sps')}`, rounds: '10' })
        await algorand.dt.getBoxesVersions(5n, { prefix: '' })
        expect(stub.calls[2].query.prefix).toBeUndefined()
      })

      test('checks before sending: 64 bytes at most, no key with rounds, a fork with versions-pages', async () => {
        await expect(algorand.dt.getAppVersions(5n, { key: new Uint8Array(65) })).rejects.toThrow(/65 bytes/)
        await expect(algorand.dt.iterateBoxesVersions(5n, { prefix: 'x'.repeat(65) }).next()).rejects.toThrow(/65 bytes/)
        await expect(algorand.dt.getAppVersions(5n, { key: 'k', rounds: [5] })).rejects.toThrow(/key cannot be combined with rounds/)
        await withoutFeatures(['versions-pages'], async () => {
          await expect(algorand.dt.getAppVersions(5n, { key: 'k' })).rejects.toThrow(DTNotAvailableError)
          await expect(algorand.dt.getBoxesVersions(5n, { prefix: 'p' })).rejects.toThrow(/versions-pages/)
        })
        expect(stub.calls).toHaveLength(0)
        // dtalgosdk 3.9.0-dt.3.0.0.1 as released lists no versions-filters feature: key and prefix don't need one
        stub
          .on('get', '/v2/applications/5/versions', json({ round: 9, versions: [] }))
          .on('get', '/v2/applications/5/boxes/versions', json({ round: 9, versions: [] }))
        await withoutFeatures(['versions-filters'], async () => {
          await algorand.dt.getAppVersions(5n, { key: 'k' })
          await algorand.dt.getBoxesVersions(5n, { prefix: 'p' })
        })
        expect(stub.calls.map((c) => [c.query.key, c.query.prefix])).toEqual([
          ['b64:aw==', undefined],
          [undefined, 'b64:cA=='],
        ])
      })
    })
  })

  describe('box listings', () => {
    const boxesPath = '/v2/applications/5/boxes'
    const listing = (boxes: [string | Uint8Array, (string | Uint8Array)?][], round?: number, next?: string) =>
      json({
        ...(round !== undefined ? { round } : {}),
        boxes: boxes.map(([name, value]) => ({ name: b64(name), ...(value !== undefined ? { value: b64(value) } : {}) })),
        ...(next ? { 'next-token': next } : {}),
      })
    const boxValue = (call: Call): Answer => {
      const name = Buffer.from(call.query.name.slice(4), 'base64').toString()
      return { status: 200, json: { round: LAST_ROUND, name: b64(name), value: b64(`value of ${name}`) } }
    }

    test('one paged listing with prefix, values and limit; pages pinned to a given round', async () => {
      stub.on('get', boxesPath, listing([['ua', 'A']], 70, 'b64:dWE=')).on('get', boxesPath, listing([['ub', '']], 70))
      const boxes = await algorand.app.getBoxes(5n, { prefix: 'u', includeValues: true, limit: 1, round: 70 })
      expect(stub.calls.map((c) => c.query)).toEqual([
        { prefix: `b64:${b64('u')}`, include: 'values', limit: 1, round: '70' },
        { prefix: `b64:${b64('u')}`, include: 'values', limit: 1, round: '70', next: 'b64:dWE=' },
      ])
      expect(boxes.map((b) => [b.name.name, Buffer.from(b.value!).toString()])).toEqual([
        ['ua', 'A'],
        ['ub', ''],
      ])

      // At the latest round nothing is pinned; without values none are returned
      stub.calls = []
      stub.on('get', boxesPath, listing([['ua']], LAST_ROUND))
      const names = await algorand.app.getBoxes(5n, { prefix: 'u' })
      expect(stub.calls[0].query.round).toBeUndefined()
      expect(names).toEqual([{ name: expect.objectContaining({ name: 'ua' }) }])
    })

    test('a node that ignores paging: the names are filtered here and the values read', async () => {
      stub.on('get', boxesPath, listing([['ua'], ['v'], ['ub']])).on('get', '/v2/applications/5/box', boxValue, true)
      const boxes = await algorand.app.getBoxes(5n, { prefix: 'u', includeValues: true })
      expect(boxes.map((b) => [b.name.name, Buffer.from(b.value!).toString()])).toEqual([
        ['ua', 'value of ua'],
        ['ub', 'value of ub'],
      ])
      expect(stub.calls).toHaveLength(3)
    })

    test('an algosdk without the paged builder: the same fallback', async () => {
      const algod = algorand.client.algod
      const original = algod.getApplicationBoxes.bind(algod)
      const spy = vi
        .spyOn(algod, 'getApplicationBoxes')
        .mockImplementation((id) => Object.assign(original(id), { prefix: undefined, include: undefined }))
      try {
        stub.on('get', boxesPath, listing([['ua'], ['v']])).on('get', '/v2/applications/5/box', boxValue, true)
        const boxes = await algorand.app.getBoxes(5n, { prefix: new Uint8Array(Buffer.from('u')), includeValues: true })
        expect(stub.calls[0].query.prefix).toBeUndefined()
        expect(boxes.map((b) => b.name.name)).toEqual(['ua'])
      } finally {
        spy.mockRestore()
      }
    })

    test('box getMap reads the map with one listing, as before', async () => {
      const bName = (k: bigint) => new Uint8Array([...Buffer.from('b'), ...algosdk.encodeUint64(k)])
      const abiString = (v: string) => new algosdk.ABIStringType().encode(v)
      stub.on(
        'get',
        boxesPath,
        listing(
          [
            [bName(1n), abiString('one')],
            [bName(2n), abiString('two')],
          ],
          LAST_ROUND,
        ),
      )
      const client = new AppClient({ appId: 5n, appSpec: JSON.stringify(boxMapArc56), algorand, defaultSender: address })
      const map = await client.state.box.getMap('bMap')
      expect([...map.entries()]).toEqual([
        [1n, 'one'],
        [2n, 'two'],
      ])
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0].query).toMatchObject({ prefix: `b64:${b64('b')}`, include: 'values' })

      // A map with prefix "" lists every box, without a prefix
      stub.calls = []
      stub.on('get', '/v2/applications/123/boxes', listing([[new Uint8Array([1, 2, 3, 4]), abiString('x')]], 1000))
      const state = new AppClient({ appId: 123n, appSpec: JSON.stringify(stateArc56), algorand, defaultSender: address }).atRound(1000)
      probeOk(stub)
      expect([...(await state.state.box.getMap('box')).entries()]).toEqual([[new Uint8Array([1, 2, 3, 4]), 'x']])
      const listed = stub.calls.find((c) => c.path === '/v2/applications/123/boxes')!
      expect(listed.query.prefix).toBeUndefined()
      expect(listed.query.round).toBe('1000')
    })
  })

  describe('asset holders', () => {
    const other = algosdk.generateAccount().addr.toString()
    const holdersPage = (round: number, holders: [string, number, boolean][], next?: string) =>
      json({
        round,
        holders: holders.map(([a, amount, frozen]) => ({ address: a, amount, 'is-frozen': frozen })),
        ...(next ? { 'next-token': next } : {}),
      })

    test('a page maps the holders; next needs the first page round', async () => {
      stub.on('get', '/v2/assets/9/holders', holdersPage(900, [[address, 5, true]], address))
      const controller = new AbortController()
      const page = await algorand.dt.getAssetHolders(9n, { round: 900, limit: 1, next: other, signal: controller.signal })
      expect(stub.calls[0].query).toMatchObject({ round: '900', limit: '1', next: other })
      expect(stub.calls[0].options?.signal).toBe(controller.signal)
      expect(page).toEqual({ round: 900n, holders: [{ address, amount: 5n, frozen: true }], nextToken: address })
      await expect(algorand.dt.getAssetHolders(9n, { next: address })).rejects.toThrow(/round with next/)
      expect(stub.calls).toHaveLength(1)
    })

    test('the iterator pins the first page round and goes on through an empty page with a token', async () => {
      stub
        .on('get', '/v2/assets/9/holders', holdersPage(900, [[address, 1, false]], address))
        .on('get', '/v2/assets/9/holders', holdersPage(900, [], other))
        .on('get', '/v2/assets/9/holders', holdersPage(900, [[other, 2, false]]))
      const controller = new AbortController()
      const holders = []
      for await (const h of algorand.dt.iterateAssetHolders(9n, { limit: 1, signal: controller.signal })) holders.push(h)
      expect(holders).toEqual([
        { address, amount: 1n, frozen: false },
        { address: other, amount: 2n, frozen: false },
      ])
      expect(stub.calls.map((c) => [c.query.round, c.query.next])).toEqual([
        [undefined, undefined],
        ['900', address],
        ['900', other],
      ])
      expect(stub.calls.every((c) => c.options?.signal === controller.signal)).toBe(true)
    })

    test('an older fork without holders throws DTNotAvailableError', async () => {
      await withoutFeatures(['holders'], async () => {
        await expect(algorand.dt.getAssetHolders(9n)).rejects.toThrow(DTNotAvailableError)
        await expect(algorand.dt.iterateAssetHolders(9n).next()).rejects.toThrow(/holders/)
      })
    })
  })

  describe('app client at a round', () => {
    const appClient = () => new AppClient({ appId: 123n, appSpec: JSON.stringify(stateArc56), algorand, defaultSender: address })

    test('state reads use the pinned round', async () => {
      probeOk(stub).on('get', '/v2/applications/123', json(appJson(123, address, 8)))
      const past = appClient().atRound(1000)
      expect(past.round).toBe(1000n)
      expect(await past.state.global.getValue('int1')).toBe(8n)
      expect(stub.calls.at(-1)!.query.round).toBe('1000')
    })

    test('clone keeps the round and atRound(undefined) clears it', () => {
      const past = appClient().atRound(5n)
      expect(past.clone({}).round).toBe(5n)
      expect(past.atRound(undefined).round).toBeUndefined()
    })

    test('readonly calls simulate at the pinned round, with transactions valid at it', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams).on(
        'post',
        '/v2/transactions/simulate',
        echoSimulate(() => uint64Return(42n)),
      )
      const result = await appClient()
        .atRound(1000)
        .send.call({ method: 'call_abi_uint64_readonly', args: [1n] })
      expect(result.return).toBe(42n)
      const request = sentSimulate(stub.calls.at(-1)!)
      expect(request.round).toBe(1000n)
      expect(request.txnGroups[0].txns[0].txn.firstValid).toBe(1001n)
      expect(request.txnGroups[0].txns[0].txn.lastValid).toBeGreaterThanOrEqual(1001n)
    })

    test('readonly calls use the node limit as the extra opcode budget', async () => {
      limitsOk(stub, { 'max-extra-opcode-budget': 100_000 })
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate(() => uint64Return(42n)),
          true,
        )
      await appClient().send.call({ method: 'call_abi_uint64_readonly', args: [1n] })
      expect(sentSimulate(stub.calls.at(-1)!).extraOpcodeBudget).toBe(100_000)

      // Above stock algod's limit too
      const raised = new StubClient()
      limitsOk(raised, { 'max-extra-opcode-budget': 640_000 })
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate(() => uint64Return(42n)),
          true,
        )
      const other = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(raised, '') })
      await new AppClient({ appId: 123n, appSpec: JSON.stringify(stateArc56), algorand: other, defaultSender: address }).send.call({
        method: 'call_abi_uint64_readonly',
        args: [1n],
      })
      expect(sentSimulate(raised.calls.at(-1)!).extraOpcodeBudget).toBe(640_000)

      // The limits are asked for once per algod client
      await appClient().send.call({ method: 'call_abi_uint64_readonly', args: [1n] })
      expect(limitsCalls(stub)).toHaveLength(1)
    })

    test('readonly calls use the stock budget without a limits endpoint, or when it fails', async () => {
      limits404(stub)
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate(() => uint64Return(42n)),
          true,
        )
      await appClient().send.call({ method: 'call_abi_uint64_readonly', args: [1n] })
      expect(sentSimulate(stub.calls.at(-1)!).extraOpcodeBudget).toBe(320_000)

      // A node that fails the limits request is not asked again
      const failing = new StubClient()
        .on('get', '/v2/transactions/simulate/limits', () => ({ status: 503, json: {} }), true)
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate(() => uint64Return(42n)),
          true,
        )
      const other = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(failing, '') })
      const client = new AppClient({ appId: 123n, appSpec: JSON.stringify(stateArc56), algorand: other, defaultSender: address })
      expect((await client.send.call({ method: 'call_abi_uint64_readonly', args: [1n] })).return).toBe(42n)
      await client.send.call({ method: 'call_abi_uint64_readonly', args: [1n] })
      expect(sentSimulate(failing.calls.at(-1)!).extraOpcodeBudget).toBe(320_000)
      expect(limitsCalls(failing)).toHaveLength(1)
    })

    test('a pinned client cannot send transactions', async () => {
      const past = appClient().atRound(1000)
      await expect(past.send.call({ method: 'set_global', args: [1n, 2n, 'a', new Uint8Array(4)] })).rejects.toThrow(/pinned to round 1000/)
      await expect(past.send.bare.call()).rejects.toThrow(/pinned to round 1000/)
      await expect(past.send.fundAppAccount({ amount: algo(1) })).rejects.toThrow(/pinned to round 1000/)
      expect(stub.calls).toHaveLength(0)
    })
  })

  describe('extended simulate', () => {
    const payment = (amount: number) => algorand.newGroup().addPayment({ sender, receiver: sender, amount: microAlgo(amount) })

    beforeEach(() => {
      limitsOk(stub)
    })

    test('groups: several groups in one request', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams).on(
        'post',
        '/v2/transactions/simulate',
        echoSimulate(undefined, (g) => (g === 1 ? 'overspend' : undefined)),
      )
      const outcomes = await algorand.simulate.groups(
        [payment(1), payment(2).addPayment({ sender, receiver: sender, amount: microAlgo(3) })],
        {
          allowUnnamedResources: true,
        },
      )
      const request = sentSimulate(stub.calls.at(-1)!)
      expect(request.txnGroups.map((g) => g.txns.length)).toEqual([1, 2])
      expect(request.allowEmptySignatures).toBe(true)
      expect(request.allowUnnamedResources).toBe(true)
      expect(request.parallelGroups).toBeFalsy()
      expect(outcomes).toHaveLength(2)
      expect(outcomes[0].ok).toBe(true)
      if (outcomes[0].ok) {
        expect(outcomes[0].result.transactions).toHaveLength(1)
        expect(outcomes[0].result.confirmations).toHaveLength(1)
      }
      expect(outcomes[1].ok).toBe(false)
      if (!outcomes[1].ok) expect(outcomes[1].error).toMatchObject({ kind: 'group', failureMessage: 'overspend' })
      // The two-transaction group got a group ID
      const group2 = request.txnGroups[1].txns.map((t) => t.txn.group)
      expect(group2[0]).toBeDefined()
      expect(group2[0]).toEqual(group2[1])
    })

    test('groups: a signal goes to fetch and stays out of the request body', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams).on('post', '/v2/transactions/simulate', echoSimulate())
      const controller = new AbortController()
      await algorand.simulate.groups([payment(1)], { signal: controller.signal })
      const call = stub.calls.at(-1)!
      expect(call.options).toEqual({ signal: controller.signal })
      const body = algosdk.msgpackRawDecode(call.body!) as Map<string, unknown> | Record<string, unknown>
      const keys = body instanceof Map ? [...body.keys()] : Object.keys(body)
      expect(keys).not.toContain('signal')
      // Once aborted, nothing more is sent
      controller.abort()
      const sent = stub.calls.length
      await expect(algorand.simulate.groups([payment(1)], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
      expect(stub.calls).toHaveLength(sent)
    })

    test('groups: parallel groups beyond maxGroups are split across requests; sequential ones throw', async () => {
      stub
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('get', '/v2/status', nodeStatus)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      const outcomes = await algorand.simulate.groups([payment(1), payment(2), payment(3)], { parallel: true, maxGroups: 2 })
      const requests = stub.calls.filter((c) => c.method === 'post').map(sentSimulate)
      // Both requests at the same round, the latest when they were sent
      // A group alone is sent without parallelGroups, as a plain request
      expect(requests.map((r) => [r.txnGroups.length, r.parallelGroups, r.round])).toEqual([
        [2, true, BigInt(LAST_ROUND)],
        [1, undefined, BigInt(LAST_ROUND)],
      ])
      expect(outcomes.map((o) => [o.groupIndex, o.ok])).toEqual([
        [0, true],
        [1, true],
        [2, true],
      ])
      await expect(algorand.simulate.groups([payment(1), payment(2), payment(3)], { maxGroups: 2 })).rejects.toThrow(/at most 2/)
    })

    test('groups at a past round build transactions valid at it', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams).on('post', '/v2/transactions/simulate', echoSimulate())
      const [outcome] = await algorand.simulate.groups([payment(1)], { round: 2000 })
      const request = sentSimulate(stub.calls.at(-1)!)
      expect(request.round).toBe(2000n)
      expect(request.txnGroups[0].txns[0].txn.firstValid).toBe(2001n)
      expect(outcome.round).toBe(2000n)
    })

    test('rounds: packs rounds into windows and returns outcomes in input order', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams, true).on(
        'post',
        '/v2/transactions/simulate',
        echoSimulate((txn) => uint64Return(txn.firstValid)),
        true,
      )
      const composer = algorand
        .newGroup()
        .addAppCallMethodCall({ sender, appId: 123n, method: algosdk.ABIMethod.fromSignature('get()uint64') })
      const rounds = [5000n, 1000n, 1500n, 5001n]
      const outcomes = await algorand.simulate.rounds(composer, rounds)
      const requests = stub.calls.filter((c) => c.method === 'post').map(sentSimulate)
      expect(requests.map((r) => r.rounds)).toEqual([
        [1000n, 1500n],
        [5000n, 5001n],
      ])
      expect(requests.map((r) => [r.txnGroups[0].txns[0].txn.firstValid, r.txnGroups[0].txns[0].txn.lastValid])).toEqual([
        [1001n, 1501n],
        [5001n, 5002n],
      ])
      expect(outcomes.map((o) => o.round)).toEqual(rounds)
      // Each round's result came from its window's transactions
      expect(
        outcomes.map((o) => {
          const [g] = o.groups
          return g.ok ? [g.round, g.result.returns?.[0]?.returnValue] : undefined
        }),
      ).toEqual([
        [5000n, 5001n],
        [1000n, 1001n],
        [1500n, 1001n],
        [5001n, 5001n],
      ])
    })

    test("rounds: hashes each transaction once, and gives every round its group's IDs", async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams, true).on('post', '/v2/transactions/simulate', echoSimulate(), true)
      const group = payment(1).addPayment({ sender, receiver: sender, amount: microAlgo(2) })
      const txID = vi.spyOn(algosdk.Transaction.prototype, 'txID')
      try {
        const outcomes = await algorand.simulate.rounds(group, [1000n, 2000n, 3000n], { validityWindow: 'rewrite' })
        const results = outcomes.map((o) => (o.groups[0].ok ? o.groups[0].result : undefined))
        // two transactions, hashed once each across the three rounds
        expect(txID).toHaveBeenCalledTimes(2)
        txID.mockRestore()
        const { transactions, txIds, groupId } = results[0]!
        expect(transactions[0].group).toBeDefined()
        expect(groupId).toBe(Buffer.from(transactions[0].group!).toString('base64'))
        expect(txIds).toEqual(transactions.map((t) => t.txID()))
        for (const r of results) expect([r!.txIds, r!.groupId]).toEqual([txIds, groupId])
      } finally {
        txID.mockRestore()
      }
    })

    test('rounds with a validity window mode: packs rounds far apart into one request, with a valid window', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams, true).on('post', '/v2/transactions/simulate', echoSimulate(), true)
      const outcomes = await algorand.simulate.rounds(payment(1), [20_000_000n, 1000n, 45_000_000n], { validityWindow: 'rewrite' })
      const requests = stub.calls.filter((c) => c.method === 'post').map(sentSimulate)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        rounds: [1000n, 20_000_000n, 45_000_000n],
        rewriteValidityWindow: true,
        allowEmptySignatures: true,
      })
      expect(requests[0].skipValidityWindow).toBeFalsy()
      const { firstValid, lastValid } = requests[0].txnGroups[0].txns[0].txn
      expect([firstValid, lastValid]).toEqual([1001n, 2001n])
      expect(outcomes.map((o) => [o.round, o.groups[0].ok])).toEqual([
        [20_000_000n, true],
        [1000n, true],
        [45_000_000n, true],
      ])

      const before = stub.calls.length
      await algorand.simulate.rounds(payment(1), [1000n, 45_000_000n], { validityWindow: 'skip' })
      const skipped = stub.calls
        .slice(before)
        .filter((c) => c.method === 'post')
        .map(sentSimulate)
      expect(skipped).toHaveLength(1)
      expect(skipped[0]).toMatchObject({ rounds: [1000n, 45_000_000n], skipValidityWindow: true })
      expect(skipped[0].rewriteValidityWindow).toBeFalsy()
      const txn = skipped[0].txnGroups[0].txns[0].txn
      expect([txn.firstValid, txn.lastValid]).toEqual([1001n, 2001n])

      await expect(algorand.simulate.rounds(payment(1), [1000n], { validityWindow: 'rewrites' as 'rewrite' })).rejects.toThrow(
        /must be 'skip' or 'rewrite'/,
      )
    })

    test('rounds without a validity window mode still pack within 1,000 rounds', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams, true).on('post', '/v2/transactions/simulate', echoSimulate(), true)
      await algorand.simulate.rounds(payment(1), [1000n, 45_000_000n])
      const requests = stub.calls.filter((c) => c.method === 'post').map(sentSimulate)
      expect(requests.map((r) => [r.rounds, r.skipValidityWindow, r.rewriteValidityWindow])).toEqual([
        [[1000n], undefined, undefined],
        [[45_000_000n], undefined, undefined],
      ])
    })

    test('a validity window mode is refused without rounds', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams)
      await expect(
        algorand.simulate.groups([payment(1)], { validityWindow: 'skip' } as Parameters<typeof algorand.simulate.groups>[1]),
      ).rejects.toThrow(/requires rounds/)
    })

    test('protocol: groups get the protocol override of the request', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams).on('post', '/v2/transactions/simulate', echoSimulate())
      const outcomes = await algorand.simulate.groups([payment(1), payment(2)], { protocol: 'latest' })
      expect(sentSimulate(stub.calls.at(-1)!).protocol).toBe('latest')
      expect(outcomes[0].protocolOverride).toMatchObject({ from: 'v38', to: 'v42', applied: true })
      expect(outcomes[1].protocolOverride).toBe(outcomes[0].protocolOverride)
      expect(outcomes[0].protocolOverride?.notes?.map((n) => [n.code, n.hits])).toEqual([
        ['semantics-changed', undefined],
        ['block-incentive-fields', [{ group: 0, path: [0] }]],
      ])
    })

    test('protocol: parallel groups split across requests get merged notes with group indexes in input order', async () => {
      stub
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('get', '/v2/status', nodeStatus)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      const outcomes = await algorand.simulate.groups([payment(1), payment(2), payment(3)], {
        parallel: true,
        maxGroups: 2,
        protocol: 'v42',
      })
      expect(stub.calls.filter((c) => c.method === 'post')).toHaveLength(2)
      const notes = outcomes[2].protocolOverride?.notes
      expect(notes?.map((n) => [n.code, n.hits])).toEqual([
        ['semantics-changed', undefined],
        [
          'block-incentive-fields',
          [
            { group: 0, path: [0] },
            { group: 2, path: [0] },
          ],
        ],
      ])
    })

    test('protocol: rounds get the protocol override of each round, none for a failed round', async () => {
      stub.on('get', '/v2/transactions/params', suggestedParams, true).on(
        'post',
        '/v2/transactions/simulate',
        echoSimulate(undefined, undefined, (r) => (r === 1500n ? 'protocol v42 is not a later protocol' : undefined)),
        true,
      )
      const outcomes = await algorand.simulate.rounds(payment(1), [1000n, 1500n], { protocol: 'v42' })
      expect(outcomes[0].protocolOverride).toMatchObject({ to: 'v42', applied: true })
      expect(outcomes[0].groups[0].protocolOverride).toBe(outcomes[0].protocolOverride)
      expect(outcomes[1].protocolOverride).toBeUndefined()
      expect(outcomes[1].groups[0]).toMatchObject({ ok: false, error: { kind: 'round' } })
    })

    test('protocol and validity window modes need a fork version with those features', async () => {
      const DT = algosdk.DTAlgodClient as unknown as { features: readonly string[] }
      const features = DT.features
      Object.defineProperty(DT, 'features', {
        value: features.filter((f) => f !== 'validity-window' && f !== 'simulate-protocol'),
        configurable: true,
        writable: true,
      })
      try {
        stub.on('get', '/v2/transactions/params', suggestedParams, true).on('post', '/v2/transactions/simulate', echoSimulate(), true)
        await expect(algorand.simulate.groups([payment(1)], { protocol: 'v42' })).rejects.toThrow(/simulate-protocol/)
        await expect(algorand.simulate.rounds(payment(1), [1000n], { validityWindow: 'skip' })).rejects.toThrow(DTNotAvailableError)
        expect(await algorand.simulate.groups([payment(1)])).toHaveLength(1)
      } finally {
        Object.defineProperty(DT, 'features', { value: features, configurable: true, writable: true })
      }
    })

    test('protocol: rounds in several windows with parallel groups split across requests', async () => {
      // Group 2 is alone in the second request, which fails at round 1500
      stub.on('get', '/v2/transactions/params', suggestedParams, true).on(
        'post',
        '/v2/transactions/simulate',
        echoSimulate(undefined, undefined, (r, request) =>
          r === 1500n && request.txnGroups.length === 1 ? 'not a later protocol' : undefined,
        ),
        true,
      )
      const outcomes = await algorand.simulate.rounds([payment(1), payment(2), payment(3)], [5000n, 1000n, 1500n], {
        parallel: true,
        maxGroups: 2,
        protocol: 'v42',
      })
      const requests = stub.calls.filter((c) => c.method === 'post').map(sentSimulate)
      expect(requests).toHaveLength(4)
      expect(requests.map((r) => [r.rounds, r.txnGroups.length])).toEqual(
        expect.arrayContaining([
          [[1000n, 1500n], 2],
          [[1000n, 1500n], 1],
          [[5000n], 2],
          [[5000n], 1],
        ]),
      )
      expect(outcomes.map((o) => o.round)).toEqual([5000n, 1000n, 1500n])
      for (const o of [outcomes[0], outcomes[1]]) {
        expect(o.protocolOverride?.notes?.[1].hits).toEqual([
          { group: 0, path: [0] },
          { group: 2, path: [0] },
        ])
        expect(o.groups.map((g) => [g.ok, g.protocolOverride === o.protocolOverride])).toEqual([
          [true, true],
          [true, true],
          [true, true],
        ])
      }
      // At 1500 only the first request has an override: the round's has its notes, the failed group none
      const failed = outcomes[2]
      expect(failed.protocolOverride?.notes?.[1].hits).toEqual([{ group: 0, path: [0] }])
      expect(failed.groups.map((g) => [g.ok, g.protocolOverride !== undefined])).toEqual([
        [true, true],
        [true, true],
        [false, false],
      ])
      expect(failed.groups[2]).toMatchObject({ ok: false, error: { kind: 'round' } })
    })
  })

  describe('simulate limits', () => {
    const payment = (amount: number) => algorand.newGroup().addPayment({ sender, receiver: sender, amount: microAlgo(amount) })
    const posts = () => stub.calls.filter((c) => c.method === 'post').map(sentSimulate)

    test('limits: the node limits, asked for once per algod client', async () => {
      limitsOk(stub, { 'max-txn-groups': 8, 'max-rounds': 4, 'developer-api': true })
      const limits = await algorand.simulate.limits()
      expect(limits).toEqual({
        maxTxnGroups: 8,
        maxRounds: 4,
        maxExtraOpcodeBudget: 320_000,
        resourceLimitMultiplier: 1,
        timeTravel: true,
        developerApi: true,
        reported: true,
      })
      await algorand.simulate.limits()
      expect(limitsCalls(stub)).toHaveLength(1)
      expect(stub.calls[0].path).toBe('/v2/transactions/simulate/limits')
    })

    test('limits: stock algod limits after a 404', async () => {
      limits404(stub)
      expect(await algorand.simulate.limits()).toEqual({
        maxTxnGroups: 1,
        maxRounds: 0,
        maxExtraOpcodeBudget: 320_000,
        resourceLimitMultiplier: 1,
        timeTravel: false,
        developerApi: false,
        reported: false,
      })
    })

    test('limits: other errors are thrown and asked again next time', async () => {
      stub.on('get', '/v2/transactions/simulate/limits', () => ({ status: 503, json: {} }))
      limitsOk(stub)
      await expect(algorand.simulate.limits()).rejects.toMatchObject({ status: 503 })
      expect((await algorand.simulate.limits()).maxTxnGroups).toBe(16)
    })

    test('groups: maxGroups defaults to the node limit', async () => {
      limitsOk(stub, { 'max-txn-groups': 2 })
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('get', '/v2/status', nodeStatus)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      const outcomes = await algorand.simulate.groups([payment(1), payment(2), payment(3)], { parallel: true })
      expect(posts().map((r) => r.txnGroups.length)).toEqual([2, 1])
      expect(outcomes.map((o) => o.ok)).toEqual([true, true, true])
      await expect(algorand.simulate.groups([payment(1), payment(2), payment(3)])).rejects.toThrow(/at most 2 per request \(set/)
      // maxGroups overrides the node limit
      await algorand.simulate.groups([payment(1), payment(2), payment(3)], { maxGroups: 3 })
      expect(posts().at(-1)!.txnGroups).toHaveLength(3)
      await expect(algorand.simulate.groups([payment(1)], { maxGroups: 0 })).rejects.toThrow(/positive integer/)
    })

    test('rounds: maxRounds defaults to the node limit', async () => {
      limitsOk(stub, { 'max-rounds': 1 })
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      await algorand.simulate.rounds(payment(1), [1000n, 1001n])
      expect(posts().map((r) => r.rounds)).toEqual([[1000n], [1001n]])
    })

    test('an extraOpcodeBudget above the node limit throws', async () => {
      limitsOk(stub, { 'max-extra-opcode-budget': 100_000 })
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      await expect(algorand.simulate.groups([payment(1)], { extraOpcodeBudget: 1_000_000 })).rejects.toThrow(
        /extraOpcodeBudget 1000000 is more than the node allows \(maxExtraOpcodeBudget 100000\)/,
      )
      await expect(algorand.simulate.rounds(payment(1), [1000n], { extraOpcodeBudget: 100_001n })).rejects.toThrow(
        /more than the node allows/,
      )
      expect(posts()).toHaveLength(0)
      await algorand.simulate.groups([payment(1)], { extraOpcodeBudget: 100_000 })
      expect(posts().map((r) => r.extraOpcodeBudget)).toEqual([100_000])
    })

    test('without a limits endpoint, the node checks extraOpcodeBudget itself', async () => {
      limits404(stub)
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      await algorand.simulate.groups([payment(1)], { extraOpcodeBudget: 1_000_000 })
      expect(posts().map((r) => r.extraOpcodeBudget)).toEqual([1_000_000])
    })

    test('protocol future and execTraceConfig are refused when the node reports the developer API off', async () => {
      limitsOk(stub).on('get', '/v2/transactions/params', suggestedParams, true)
      await expect(algorand.simulate.groups([payment(1)], { protocol: 'future' })).rejects.toThrow(
        /protocol 'future' needs .*EnableDeveloperAPI/,
      )
      await expect(
        algorand.simulate.rounds(payment(1), [1000n], { execTraceConfig: new modelsv2.SimulateTraceConfig({ enable: true }) }),
      ).rejects.toThrow(/execTraceConfig needs .*EnableDeveloperAPI/)
      expect(posts()).toHaveLength(0)
    })

    test('protocol future and execTraceConfig are sent when the developer API is on, or unknown', async () => {
      const trace = { execTraceConfig: new modelsv2.SimulateTraceConfig({ enable: true }) }
      limitsOk(stub, { 'developer-api': true })
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      await algorand.simulate.groups([payment(1)], { protocol: 'future', ...trace })
      expect(posts().at(-1)).toMatchObject({ protocol: 'future', execTraceConfig: { enable: true } })

      // Without the limits endpoint the node checks it
      const stock = new StubClient()
      limits404(stock)
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      const other = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(stock, '') })
      await other.simulate.groups([other.newGroup().addPayment({ sender, receiver: sender, amount: microAlgo(1) })], trace)
      expect(sentSimulate(stock.calls.at(-1)!).execTraceConfig?.enable).toBe(true)
    })

    test('without a limits endpoint: one group per request, as plain upstream requests', async () => {
      limits404(stub)
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('get', '/v2/status', nodeStatus)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate(undefined, (g) => (g === 0 ? undefined : 'never')),
          true,
        )
      await expect(algorand.simulate.groups([payment(1), payment(2)])).rejects.toThrow(
        /at most 1 per request \(it has no simulate limits endpoint/,
      )
      const outcomes = await algorand.simulate.groups([payment(1), payment(2)], { parallel: true })
      expect(posts().map((r) => [r.txnGroups.length, r.parallelGroups, r.rounds, r.round])).toEqual([
        [1, undefined, undefined, BigInt(LAST_ROUND)],
        [1, undefined, undefined, BigInt(LAST_ROUND)],
      ])
      expect(outcomes.map((o) => [o.groupIndex, o.ok])).toEqual([
        [0, true],
        [1, true],
      ])
    })

    test('without a limits endpoint: rounds are simulated one request per round, with round set', async () => {
      limits404(stub)
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate((txn) => uint64Return(txn.firstValid)),
          true,
        )
      const composer = algorand
        .newGroup()
        .addAppCallMethodCall({ sender, appId: 123n, method: algosdk.ABIMethod.fromSignature('get()uint64') })
      const rounds = [5000n, 1000n, 5000n]
      const outcomes = await algorand.simulate.rounds(composer, rounds, { validityWindow: 'rewrite' })
      const requests = posts()
      // One request per distinct round, with transactions valid at it, and no fork fields
      expect(requests.map((r) => [r.round, r.rounds, r.rewriteValidityWindow, r.txnGroups[0].txns[0].txn.firstValid])).toEqual([
        [5000n, undefined, undefined, 5001n],
        [1000n, undefined, undefined, 1001n],
      ])
      expect(outcomes.map((o) => [o.round, o.groups[0].round, o.groups[0].ok && o.groups[0].result.returns?.[0]?.returnValue])).toEqual([
        [5000n, 5000n, 5001n],
        [1000n, 1000n, 1001n],
        [5000n, 5000n, 5001n],
      ])
      await expect(algorand.simulate.rounds(composer, [1000n, 0])).rejects.toThrow(RangeError)
    })

    test('maxRounds 0 sends one request per round on dtalgod too', async () => {
      limitsOk(stub)
        .on('get', '/v2/transactions/params', suggestedParams, true)
        .on('post', '/v2/transactions/simulate', echoSimulate(), true)
      await algorand.simulate.rounds(payment(1), [1000n, 1001n], { maxRounds: 0 })
      expect(posts().map((r) => [r.round, r.rounds])).toEqual([
        [1000n, undefined],
        [1001n, undefined],
      ])
    })

    test('a fork without the simulate-limits feature keeps the default limits and asks nothing', async () => {
      await withoutFeatures(['simulate-limits'], async () => {
        stub.on('get', '/v2/transactions/params', suggestedParams, true).on('post', '/v2/transactions/simulate', echoSimulate(), true)
        await algorand.simulate.groups([payment(1), payment(2)], { extraOpcodeBudget: 1_000_000 })
        await algorand.simulate.rounds(payment(1), [1000n, 1001n])
        expect(posts().map((r) => [r.txnGroups.length, r.rounds, r.extraOpcodeBudget])).toEqual([
          [2, undefined, 1_000_000],
          [1, [1000n, 1001n], undefined],
        ])
        expect(limitsCalls(stub)).toHaveLength(0)
        await expect(algorand.simulate.limits()).rejects.toThrow(DTNotAvailableError)
      })
    })
  })
})

/** dtalgod's query limits, as its simulate limits endpoint answers them. */
const QUERY_LIMITS = {
  'max-calls': 1024,
  'max-call-budget': 320_000,
  'max-call-log-bytes': 65_536,
  'max-response-bytes': 67_108_864,
  'max-rounds': 16,
}

/** Answers the simulate limits endpoint as dtalgod with queries, with these query limits. */
const queryLimitsOk = (stub: StubClient, query: Partial<typeof QUERY_LIMITS> = {}, limits: Partial<typeof LIMITS> = {}) =>
  stub.on('get', '/v2/transactions/simulate/limits', json({ ...LIMITS, ...limits, query: { ...QUERY_LIMITS, ...query } }), true)

type SentQueryCall = {
  args?: Uint8Array[]
  accounts?: string[]
  'foreign-apps'?: bigint[]
  'foreign-assets'?: bigint[]
  boxes?: { app?: bigint; name: Uint8Array }[]
}
type SentQuery = {
  program?: Uint8Array
  'clear-program'?: Uint8Array
  'global-schema'?: { 'num-uint'?: bigint; 'num-byte-slice'?: bigint }
  'local-schema'?: { 'num-uint'?: bigint; 'num-byte-slice'?: bigint }
  'app-id'?: bigint
  sender?: string
  rounds?: bigint[]
  protocol?: string
  budget?: bigint
  calls: SentQueryCall[]
}

/** The body of a query request, decoded with the node's keys. */
const sentQuery = (call: Call) => algosdk.msgpackRawDecode(call.body!) as SentQuery

const queries = (stub: StubClient) => stub.calls.filter((c) => c.path === '/v2/query')

/**
 * A query answer where each call logs its first arg (or nothing) and the round + 1, at each round (0 answered as
 * LAST_ROUND), with cost 10 + its index in the request. `callError` fails a call after its logs, `roundError` a round.
 * With a protocol other than `round`, each round has a protocol override with a note hit on the request's first call.
 * With `abi`, each call logs an ABI return of the round + 1 instead.
 */
const queryEcho =
  ({
    callError,
    roundError,
    abi,
  }: {
    callError?: (arg: string, round: bigint) => string | undefined
    roundError?: (round: bigint) => string | undefined
    abi?: boolean
  } = {}) =>
  (call: Call): Answer => {
    const request = sentQuery(call)
    const rounds = (request.rounds ?? [0n]).map((r) => (r === 0n ? BigInt(LAST_ROUND) : r))
    const override =
      request.protocol && request.protocol !== 'round'
        ? {
            from: 'v38',
            to: 'v42',
            applied: true,
            notes: [
              { code: 'semantics-changed', message: 'MinTxnFee: 1000 → 1000' },
              { code: 'block-incentive-fields', message: 'block read an incentive field', hits: [{ group: 0, path: [0] }] },
            ],
          }
        : undefined
    const body = {
      'last-round': LAST_ROUND,
      rounds: rounds.map((round) => {
        const error = roundError?.(round)
        if (error) return { round, error }
        return {
          round,
          ...(override ? { protocol: override } : {}),
          calls: request.calls.map((c, i) => {
            const arg = c.args?.[0]
            const failure = callError?.(Buffer.from(arg ?? []).toString(), round)
            return {
              logs: abi ? [uint64Return(round + 1n)] : [...(arg ? [arg] : []), algosdk.encodeUint64(round + 1n)],
              cost: 10 + i,
              ...(failure ? { error: failure } : {}),
            }
          }),
        }
      }),
    }
    return { status: 200, body: algosdk.msgpackRawEncode(body) }
  }

const tooLarge = () => ({ status: 400, json: { message: 'query response too large: over 1000 bytes' } })
const enc = (text: string) => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
/** The logs of each call outcome as text (the round log as a number), or the error kind. */
const callLogs = (results: { round: bigint; calls: QueryCallOutcome[] }[]) =>
  results.map((r) => [
    r.round,
    r.calls.map((c) => (c.ok ? c.logs.map((l) => (l.length === 8 ? algosdk.decodeUint64(l, 'bigint') : dec(l))) : c.error.kind)),
  ])

describe('query', () => {
  let stub: StubClient
  let algorand: AlgorandClient
  const program = new Uint8Array([10, 50, 6, 22, 176, 54, 26, 0, 176, 129, 1])
  const someone = algosdk.generateAccount().addr.toString()

  beforeEach(() => {
    stub = new StubClient()
    algorand = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(stub, '') })
  })

  describe('run', () => {
    test('one request: the request body, the results in order and the signal', async () => {
      queryLimitsOk(stub).on('post', '/v2/query', queryEcho({ callError: (arg) => (arg === '' ? 'logic eval error: no arg' : undefined) }))
      const controller = new AbortController()
      const results = await algorand.query.run(
        {
          program,
          sender: someone,
          budget: 1000,
          rounds: [1000, 2000n],
          calls: [
            { args: [enc('hi')], accounts: [someone], foreignApps: [5], foreignAssets: [6n], boxes: [{ app: 0, name: enc('b') }] },
            {},
          ],
        },
        { signal: controller.signal },
      )
      const [call] = queries(stub)
      expect(call.query.format).toBe('msgpack')
      expect(call.options?.signal).toBeInstanceOf(AbortSignal)
      const body = sentQuery(call)
      expect(Object.keys(body).sort()).toEqual(['budget', 'calls', 'program', 'rounds', 'sender'])
      expect(body).toMatchObject({ program, sender: someone, budget: 1000n, rounds: [1000n, 2000n] })
      expect(body.calls).toEqual([
        { args: [enc('hi')], accounts: [someone], 'foreign-apps': [5n], 'foreign-assets': [6n], boxes: [{ name: enc('b') }] },
        {},
      ])
      expect(callLogs(results)).toEqual([
        [1000n, [['hi', 1001n], 'call']],
        [2000n, [['hi', 2001n], 'call']],
      ])
      const failed = results[0].calls[1]
      expect(failed).toMatchObject({ ok: false, callIndex: 1, round: 1000n })
      if (!failed.ok) {
        expect(failed.error).toBeInstanceOf(QueryCallError)
        expect(failed.error).toMatchObject({
          kind: 'call',
          failureMessage: 'logic eval error: no arg',
          cost: 11,
          callIndex: 1,
          round: 1000n,
        })
        expect(failed.error.logs.map((l) => algosdk.decodeUint64(l, 'bigint'))).toEqual([1001n])
        expect(failed.error.message).toBe('Query call 1 at round 1000 failed: logic eval error: no arg')
      }
      expect(results[0].calls[0]).toMatchObject({ ok: true, cost: 10 })
    })

    test('an app ID and a protocol; without rounds, the latest round', async () => {
      queryLimitsOk(stub).on('post', '/v2/query', queryEcho())
      const [result] = await algorand.query.run({ appId: 77n, protocol: 'latest', calls: [{ args: [enc('a')] }] })
      const body = sentQuery(queries(stub)[0])
      expect(body).toMatchObject({ 'app-id': 77n, protocol: 'latest', rounds: [0n] })
      expect(body.program).toBeUndefined()
      expect(result.round).toBe(BigInt(LAST_ROUND))
      expect(result.protocolOverride).toMatchObject({ from: 'v38', to: 'v42', applied: true })
    })

    test('chunking by the node limits and the options, results in input order, duplicated rounds sent once', async () => {
      queryLimitsOk(stub, { 'max-calls': 2, 'max-rounds': 2 }).on('post', '/v2/query', queryEcho(), true)
      const calls = ['a', 'b', 'c', 'd', 'e'].map((a) => ({ args: [enc(a)] }))
      const results = await algorand.query.run({ program, rounds: [30, 10, 20, 10], calls })
      const sent = queries(stub).map(sentQuery)
      expect(sent).toHaveLength(6)
      expect(sent.map((q) => [q.rounds, q.calls.map((c) => dec(c.args![0])).join('')])).toEqual(
        expect.arrayContaining([
          [[30n, 10n], 'ab'],
          [[30n, 10n], 'cd'],
          [[30n, 10n], 'e'],
          [[20n], 'ab'],
          [[20n], 'cd'],
          [[20n], 'e'],
        ]),
      )
      expect(results.map((r) => r.round)).toEqual([30n, 10n, 20n, 10n])
      for (const r of results) {
        expect(r.calls.map((c) => (c.ok ? dec(c.logs[0]) : undefined))).toEqual(['a', 'b', 'c', 'd', 'e'])
        expect(r.calls.map((c) => c.callIndex)).toEqual([0, 1, 2, 3, 4])
      }
      // The options lower the limits
      stub.calls = []
      await algorand.query.run({ program, rounds: [1, 2], calls }, { maxCalls: 1, maxRounds: 1 })
      expect(queries(stub)).toHaveLength(10)
    })

    test('calls are split by the request body limit; a call too large alone throws', async () => {
      queryLimitsOk(stub).on('post', '/v2/query', queryEcho(), true)
      const big = (fill: number) => ({ args: [new Uint8Array(400_000).fill(fill)] })
      const results = await algorand.query.run({ program, rounds: [5], calls: [big(1), big(2), big(3)] })
      expect(queries(stub).map((c) => sentQuery(c).calls.length)).toEqual([2, 1])
      expect(queries(stub).every((c) => c.body!.length < 1_000_000)).toBe(true)
      expect(results[0].calls.map((c) => c.ok && c.logs[0][0])).toEqual([1, 2, 3])
      await expect(algorand.query.run({ program, calls: [{ args: [new Uint8Array(1_000_000)] }] })).rejects.toThrow(/too large to send/)
    })

    test('the latest round is resolved first when it is queried in more than one request', async () => {
      queryLimitsOk(stub, { 'max-calls': 2 }).on('get', '/v2/status', nodeStatus).on('post', '/v2/query', queryEcho(), true)
      const calls = [{ args: [enc('a')] }, { args: [enc('b')] }, { args: [enc('c')] }]
      const [result] = await algorand.query.run({ program, rounds: [0], calls })
      expect(stub.calls.filter((c) => c.path === '/v2/status')).toHaveLength(1)
      expect(queries(stub).map((c) => sentQuery(c).rounds)).toEqual([[BigInt(LAST_ROUND)], [BigInt(LAST_ROUND)]])
      expect(result.round).toBe(BigInt(LAST_ROUND))
      // In one request, the node resolves it
      stub.calls = []
      await algorand.query.run({ program, calls: calls.slice(0, 2) })
      expect(stub.calls.filter((c) => c.path === '/v2/status')).toHaveLength(0)
      expect(sentQuery(queries(stub)[0]).rounds).toEqual([0n])
    })

    test('a response too large is split by rounds, then by calls; a call too large alone fails on its own', async () => {
      queryLimitsOk(stub)
        .on('post', '/v2/query', tooLarge) // 2 rounds × 2 calls
        .on('post', '/v2/query', tooLarge) // round 10 × 2 calls
        .on('post', '/v2/query', queryEcho()) // round 20 × 2 calls
        .on('post', '/v2/query', queryEcho()) // round 10 × call 0
        .on('post', '/v2/query', tooLarge) // round 10 × call 1
      const results = await algorand.query.run({ program, rounds: [10, 20], calls: [{ args: [enc('a')] }, { args: [enc('b')] }] })
      expect(queries(stub).map((c) => [sentQuery(c).rounds, sentQuery(c).calls.length])).toEqual([
        [[10n, 20n], 2],
        [[10n], 2],
        [[20n], 2],
        [[10n], 1],
        [[10n], 1],
      ])
      expect(callLogs(results)).toEqual([
        [10n, [['a', 11n], 'call']],
        [
          20n,
          [
            ['a', 21n],
            ['b', 21n],
          ],
        ],
      ])
      const alone = results[0].calls[1]
      if (!alone.ok)
        expect(alone.error).toMatchObject({ kind: 'call', failureMessage: 'query response too large: over 1000 bytes', logs: [] })
    })

    test('a call too large alone at the latest round throws if the latest round cannot be looked up', async () => {
      queryLimitsOk(stub)
        .on('post', '/v2/query', tooLarge)
        .on('get', '/v2/status', () => ({ status: 500, json: { message: 'status failed' } }))
      await expect(algorand.query.run({ program, calls: [{}] })).rejects.toThrow(/status failed/)
    })

    test('a 504 is split the same way, and a body over the limit splits calls', async () => {
      const timeout = () => ({ status: 504, json: { message: 'query time limit exceeded' } })
      queryLimitsOk(stub).on('post', '/v2/query', timeout).on('post', '/v2/query', queryEcho()).on('post', '/v2/query', queryEcho())
      const results = await algorand.query.run({ program, rounds: [10, 20], calls: [{}] })
      expect(queries(stub).map((c) => sentQuery(c).rounds)).toEqual([[10n, 20n], [10n], [20n]])
      expect(results.every((r) => r.calls[0].ok)).toBe(true)

      stub.calls = []
      stub
        .on('post', '/v2/query', () => ({ status: 400, json: { message: 'http: request body too large' } }))
        .on('post', '/v2/query', queryEcho())
        .on('post', '/v2/query', queryEcho())
      await algorand.query.run({ program, rounds: [10, 20], calls: [{}, {}] })
      expect(queries(stub).map((c) => [sentQuery(c).rounds, sentQuery(c).calls.length])).toEqual([
        [[10n, 20n], 2],
        [[10n, 20n], 1],
        [[10n, 20n], 1],
      ])
    })

    test('at most `concurrency` requests in flight', async () => {
      let inFlight = 0
      let most = 0
      const echo = queryEcho()
      queryLimitsOk(stub, { 'max-calls': 1 }).on(
        'post',
        '/v2/query',
        async (call) => {
          most = Math.max(most, ++inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight--
          return echo(call)
        },
        true,
      )
      const calls = Array.from({ length: 7 }, (_, i) => ({ args: [enc(String(i))] }))
      const [result] = await algorand.query.run({ program, rounds: [9], calls }, { concurrency: 2 })
      expect(queries(stub)).toHaveLength(7)
      expect(most).toBe(2)
      expect(result.calls.map((c) => c.ok && dec(c.logs[0]))).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    })

    test('a fatal error cancels the requests in flight and is thrown', async () => {
      const hang = (call: Call) =>
        new Promise<Answer>((_, reject) => {
          const signal = call.options!.signal as AbortSignal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      queryLimitsOk(stub, { 'max-calls': 1 })
        .on('post', '/v2/query', hang)
        .on('post', '/v2/query', hang)
        .on('post', '/v2/query', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { status: 400, json: { message: 'call 0: account "x": bad address' } }
        })
      const error = await algorand.query.run({ program, rounds: [9], calls: [{}, {}, {}] }, { concurrency: 3 }).catch((e) => e)
      expect(error.message).toMatch(/bad address/)
      const sent = queries(stub)
      expect(sent).toHaveLength(3)
      expect(sent.every((c) => (c.options!.signal as AbortSignal).aborted)).toBe(true)
    })

    test("aborting the caller's signal cancels the requests in flight", async () => {
      const controller = new AbortController()
      queryLimitsOk(stub).on('post', '/v2/query', (call) => {
        const signal = call.options!.signal as AbortSignal
        setTimeout(() => controller.abort(), 1)
        return new Promise<Answer>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      })
      await expect(algorand.query.run({ program, calls: [{}] }, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
      // Once aborted, nothing is sent
      const sent = stub.calls.length
      await expect(algorand.query.run({ program, calls: [{}] }, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
      expect(stub.calls).toHaveLength(sent)
    })

    test('a round error fails every call of the round', async () => {
      queryLimitsOk(stub).on('post', '/v2/query', queryEcho({ roundError: (r) => (r === 10n ? 'round 10 is not available' : undefined) }))
      const results = await algorand.query.run({ program, rounds: [10, 20], calls: [{}, {}] })
      expect(callLogs(results)).toEqual([
        [10n, ['round', 'round']],
        [20n, [[21n], [21n]]],
      ])
      const c = results[0].calls[1]
      if (!c.ok) {
        expect(c.error).toMatchObject({ kind: 'round', callIndex: 1, round: 10n, failureMessage: 'round 10 is not available', logs: [] })
        expect(c.error.message).toBe('Could not query round 10: round 10 is not available')
      }
    })

    test('protocol overrides are merged across requests, with hits at the call indexes', async () => {
      queryLimitsOk(stub, { 'max-calls': 2 }).on('get', '/v2/status', nodeStatus).on('post', '/v2/query', queryEcho(), true)
      const [result] = await algorand.query.run({ program, rounds: [100], protocol: 'latest', calls: [{}, {}, {}] })
      expect(queries(stub)).toHaveLength(2)
      expect(result.protocolOverride).toEqual({
        from: 'v38',
        to: 'v42',
        applied: true,
        notes: [
          { code: 'semantics-changed', message: 'MinTxnFee: 1000 → 1000' },
          {
            code: 'block-incentive-fields',
            message: 'block read an incentive field',
            hits: [
              { group: 0, path: [0] },
              { group: 2, path: [0] },
            ],
          },
        ],
      })
    })

    test('invalid requests throw before sending', async () => {
      queryLimitsOk(stub, { 'max-call-budget': 1000 })
      await expect(algorand.query.run({ program, calls: [] })).rejects.toThrow('A query needs at least one call')
      await expect(algorand.query.run({ calls: [{}] })).rejects.toThrow('exactly one of program and appId')
      await expect(algorand.query.run({ program, appId: 5, calls: [{}] })).rejects.toThrow('exactly one of program and appId')
      await expect(algorand.query.run({ appId: 5, clearProgram: program, calls: [{}] })).rejects.toThrow(/need program, not appId/)
      await expect(algorand.query.run({ program, rounds: [-1], calls: [{}] })).rejects.toThrow(RangeError)
      await expect(algorand.query.run({ program, calls: [{}] }, { concurrency: 0 })).rejects.toThrow(/concurrency/)
      await expect(algorand.query.run({ program, budget: 1001, calls: [{}] })).rejects.toThrow(/maxCallBudget 1000/)
      expect(queries(stub)).toHaveLength(0)
    })

    test('a node without queries throws DTUnsupportedError; supported() and limits()', async () => {
      limitsOk(stub)
      expect(await algorand.query.supported()).toBe(false)
      expect(await algorand.query.limits()).toBeUndefined()
      expect(isDTUnsupportedError(await algorand.query.run({ program, calls: [{}] }).catch((e) => e))).toBe(true)
      expect(queries(stub)).toHaveLength(0)

      stub = new StubClient()
      algorand = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(stub, '') })
      queryLimitsOk(stub).on('post', '/v2/query', () => ({ status: 404, json: { message: 'Not Found' } }))
      expect(await algorand.query.supported()).toBe(true)
      expect(await algorand.query.limits()).toEqual({
        maxCalls: 1024,
        maxCallBudget: 320_000,
        maxCallLogBytes: 65_536,
        maxResponseBytes: 67_108_864,
        maxRounds: 16,
      })
      expect(isDTUnsupportedError(await algorand.query.run({ program, calls: [{}] }).catch((e) => e))).toBe(true)
    })

    test('a fork without the query feature', async () => {
      queryLimitsOk(stub)
      await withoutFeatures(['query'], async () => {
        expect(await algorand.query.supported()).toBe(false)
        await expect(algorand.query.run({ program, calls: [{}] })).rejects.toThrow(DTNotAvailableError)
        await expect(algorand.query.limits()).rejects.toThrow(DTNotAvailableError)
      })
      expect(queries(stub)).toHaveLength(0)
    })

    test('simulate limits include the query limits only when the node has queries', async () => {
      queryLimitsOk(stub, { 'max-calls': 7 })
      expect((await algorand.simulate.limits()).query).toMatchObject({ maxCalls: 7, maxRounds: 16 })
      stub = new StubClient()
      algorand = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(stub, '') })
      limitsOk(stub)
      expect('query' in (await algorand.simulate.limits())).toBe(false)
    })
  })

  describe('groups and rounds', () => {
    const sender = algosdk.generateAccount().addr
    const clear = new Uint8Array([10, 129, 1])
    const method = new algosdk.ABIMethod({ name: 'round', args: [{ type: 'account' }, { type: 'asset' }], returns: { type: 'uint64' } })
    /** A ghost-style call: an app create method call of `program`, with an account, an asset and a box reference. */
    const ghost = (composer = algorand.newGroup(), approvalProgram = program) =>
      composer.addAppCreateMethodCall({
        sender,
        method,
        args: [someone, 6n],
        approvalProgram,
        clearStateProgram: clear,
        schema: { globalInts: 1, globalByteSlices: 2, localInts: 0, localByteSlices: 0 },
        boxReferences: [{ appId: 0n, name: 'box' }],
      })
    const appCall = (appId: bigint, composer = algorand.newGroup()) =>
      composer.addAppCallMethodCall({ sender, appId, method, args: [someone, 6n] })
    const payment = () => algorand.newGroup().addPayment({ sender, receiver: sender, amount: microAlgo(1) })
    const simulates = () => stub.calls.filter((c) => c.path === '/v2/transactions/simulate')
    const withoutCost = (outcomes: QueryGroupOutcome[]) =>
      outcomes.map((o) => {
        const { via: _via, ...rest } = o
        return rest.ok ? { ...rest, txns: rest.txns.map((t) => ({ logs: t.logs })) } : rest
      })

    beforeEach(() => {
      stub.on('get', '/v2/transactions/params', suggestedParams, true)
    })

    test('a ghost call: one request from the transaction, returns and logs, protocol round by default', async () => {
      queryLimitsOk(stub).on('post', '/v2/query', queryEcho({ abi: true }), true)
      const [outcome] = await algorand.query.groups([ghost()])
      const [call] = queries(stub)
      const body = sentQuery(call)
      expect(body).toMatchObject({
        program,
        'clear-program': clear,
        'global-schema': { 'num-uint': 1n, 'num-byte-slice': 2n },
        sender: sender.toString(),
        rounds: [0n],
        protocol: 'round',
      })
      expect(body['local-schema']).toBeUndefined()
      expect(body.budget).toBeUndefined()
      expect(body.calls).toHaveLength(1)
      expect(body.calls[0]).toMatchObject({ accounts: [someone], 'foreign-assets': [6n], boxes: [{ name: enc('box') }] })
      expect(body.calls[0].args![0]).toEqual(method.getSelector())
      expect(outcome).toMatchObject({ ok: true, via: 'query', groupIndex: 0, round: BigInt(LAST_ROUND) })
      if (outcome.ok) {
        expect(outcome.returns[0].returnValue).toBe(BigInt(LAST_ROUND) + 1n)
        expect(outcome.txns).toEqual([{ logs: [uint64Return(BigInt(LAST_ROUND) + 1n)], cost: 10 }])
      }
      expect(outcome.protocolOverride).toBeUndefined()

      stub.calls = []
      const [later] = await algorand.query.groups([ghost()], { round: 1000, protocol: 'latest' })
      expect(sentQuery(queries(stub)[0])).toMatchObject({ rounds: [1000n], protocol: 'latest' })
      expect(later.protocolOverride).toMatchObject({ applied: true })
    })

    test('calls to different programs, apps or senders go in separate requests; the same target shares one', async () => {
      queryLimitsOk(stub)
        .on('get', '/v2/status', nodeStatus)
        .on('post', '/v2/query', queryEcho({ abi: true }), true)
      const other = new Uint8Array([10, 129, 2])
      const outcomes = await algorand.query.groups([ghost(), appCall(77n), ghost(ghost(), other), appCall(77n, appCall(78n))], {
        via: 'query',
      })
      const sent = queries(stub).map(sentQuery)
      expect(sent.map((q) => [q.program ? Array.from(q.program).join() : undefined, q['app-id'], q.calls.length])).toEqual([
        [Array.from(program).join(), undefined, 2],
        [undefined, 77n, 2],
        [Array.from(other).join(), undefined, 1],
        [undefined, 78n, 1],
      ])
      // The latest round is pinned for all of them
      expect(stub.calls.filter((c) => c.path === '/v2/status')).toHaveLength(1)
      expect(sent.every((q) => q.rounds![0] === BigInt(LAST_ROUND))).toBe(true)
      expect(outcomes.map((o) => [o.groupIndex, o.ok, o.ok && o.txns.length, o.ok && o.returns.length])).toEqual([
        [0, true, 1, 1],
        [1, true, 1, 1],
        [2, true, 2, 2],
        [3, true, 2, 2],
      ])
    })

    test('the same program from another sender, or with other schemas, goes in its own request', async () => {
      queryLimitsOk(stub)
        .on('get', '/v2/status', nodeStatus)
        .on('post', '/v2/query', queryEcho({ abi: true }), true)
      const other = algosdk.generateAccount().addr
      const create = (from: algosdk.Address, globalInts: number) =>
        algorand.newGroup().addAppCreateMethodCall({
          sender: from,
          method,
          args: [someone, 6n],
          approvalProgram: program,
          clearStateProgram: clear,
          schema: { globalInts, globalByteSlices: 2, localInts: 0, localByteSlices: 0 },
        })
      const outcomes = await algorand.query.groups([ghost(), create(other, 1), create(sender, 3), ghost()])
      expect(
        queries(stub).map((c) => [sentQuery(c).sender, sentQuery(c)['global-schema']?.['num-uint'], sentQuery(c).calls.length]),
      ).toEqual([
        [sender.toString(), 1n, 2],
        [other.toString(), 1n, 1],
        [sender.toString(), 3n, 1],
      ])
      expect(outcomes.every((o) => o.ok && o.via === 'query')).toBe(true)
    })

    test('a failed call fails its group, worded as simulate does; a round error fails every group', async () => {
      queryLimitsOk(stub).on(
        'post',
        '/v2/query',
        queryEcho({
          callError: (_, round) => (round === 2000n ? 'logic eval error: assert failed pc=12. Details: app=1, pc=12' : undefined),
          roundError: (round) => (round === 3000n ? 'round 3000 is not available' : undefined),
        }),
        true,
      )
      const composer = ghost(ghost())
      const { transactions } = await composer.buildTransactions()
      const results = await algorand.query.rounds(composer, [1000, 2000, 3000])
      expect(results.map((r) => [r.round, r.groups[0].ok])).toEqual([
        [1000n, true],
        [2000n, false],
        [3000n, false],
      ])
      const atFailure = results[1].groups[0]
      expect(atFailure.via).toBe('query')
      if (!atFailure.ok) {
        expect(atFailure.error).toBeInstanceOf(QueryGroupError)
        expect(atFailure.error).toMatchObject({ kind: 'group', groupIndex: 0, round: 2000n, failedAt: [0] })
        expect(atFailure.error.failureMessage).toBe(
          `transaction ${transactions[0].txID()}: logic eval error: assert failed pc=12. Details: app=1, pc=12`,
        )
        expect(atFailure.error.message).toBe(`Querying group 0 at round 2000 failed at transaction 0: ${atFailure.error.failureMessage}`)
        expect(atFailure.error.txns).toHaveLength(2)
        expect(atFailure.error.txns![1]).toMatchObject({ cost: 11, error: expect.stringMatching(/^logic eval error/) })
      }
      const atRoundError = results[2].groups[0]
      if (!atRoundError.ok) {
        expect(atRoundError.error).toMatchObject({ kind: 'round', failureMessage: 'round 3000 is not available' })
        expect(atRoundError.error.message).toBe('Could not query group 0 at round 3000: round 3000 is not available')
      }
    })

    test('at a past round, transactions are built as simulate builds them; only logic errors get the transaction prefix', async () => {
      queryLimitsOk(stub)
        .on('post', '/v2/query', queryEcho({ callError: () => 'logic eval error: nope' }))
        .on('post', '/v2/query', tooLarge)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate(undefined, () => 'logic eval error: nope'),
        )
      const [queried] = await algorand.query.groups([ghost()], { round: 2000, via: 'query' })
      await algorand.query.groups([ghost()], { round: 2000, via: 'simulate' })
      const simulatedTxn = sentSimulate(simulates()[0]).txnGroups[0].txns[0].txn
      expect(simulatedTxn.firstValid).toBe(2001n)
      if (!queried.ok) expect(queried.error.failureMessage).toBe(`transaction ${simulatedTxn.txID()}: logic eval error: nope`)
      const [alone] = await algorand.query.groups([ghost()], { round: 2000, via: 'query' })
      if (!alone.ok) expect(alone.error.failureMessage).toBe('query response too large: over 1000 bytes')
      expect(queried.ok || alone.ok).toBe(false)
    })

    test("rounds: hashes each transaction once for every round's method returns", async () => {
      queryLimitsOk(stub).on('post', '/v2/query', queryEcho({ abi: true }), true)
      const txID = vi.spyOn(algosdk.Transaction.prototype, 'txID')
      try {
        const results = await algorand.query.rounds(ghost(ghost()), [1000, 2000, 3000])
        // two transactions, hashed once each across the three rounds
        expect(txID).toHaveBeenCalledTimes(2)
        txID.mockRestore()
        expect(results.map((r) => (r.groups[0].ok ? r.groups[0].returns.map((x) => x.returnValue) : undefined))).toEqual([
          [1001n, 1001n],
          [2001n, 2001n],
          [3001n, 3001n],
        ])
      } finally {
        txID.mockRestore()
      }
    })

    test('protocol note hits are moved to the group and transaction index', async () => {
      queryLimitsOk(stub, { 'max-calls': 2 }).on('post', '/v2/query', queryEcho({ abi: true }), true)
      const [result] = await algorand.query.rounds([ghost(), ghost(ghost())], [500], { protocol: 'latest' })
      expect(queries(stub)).toHaveLength(2)
      expect(result.protocolOverride?.notes?.[1].hits).toEqual([
        { group: 0, path: [0] },
        { group: 1, path: [1] },
      ])
      expect(result.groups.map((g) => g.protocolOverride)).toEqual([result.protocolOverride, result.protocolOverride])
    })

    describe('falls back to simulate', () => {
      const optIn = () => algorand.newGroup().addAppCall({ sender, appId: 5n, onComplete: algosdk.OnApplicationComplete.OptInOC })
      const withAccess = () => algorand.newGroup().addAppCall({ sender, appId: 5n, accessReferences: [{ appId: 9n }] })
      const cases: [string, () => void, () => TransactionComposer, QueryGroupsOptions?, (() => Promise<void>)?][] = [
        ['a payment', () => queryLimitsOk(stub), payment],
        ['an opt-in', () => queryLimitsOk(stub), optIn],
        ['an access list', () => queryLimitsOk(stub), withAccess],
        [
          'execTraceConfig',
          () => queryLimitsOk(stub, {}, { 'developer-api': true }),
          () => ghost(),
          { execTraceConfig: new modelsv2.SimulateTraceConfig({ enable: true }) },
        ],
        [
          'an extraOpcodeBudget over a query call budget',
          () => queryLimitsOk(stub, { 'max-call-budget': 10_000 }),
          () => ghost(),
          { extraOpcodeBudget: 9_500 },
        ],
        [
          'allowMoreLogging over the query log limit',
          () => queryLimitsOk(stub, { 'max-call-log-bytes': 0 }),
          () => ghost(),
          { allowMoreLogging: true },
        ],
        ['no queries on the node', () => limitsOk(stub), () => ghost()],
      ]

      test.each(cases)('%s', async (_, setup, compose, options) => {
        setup()
        stub.on('post', '/v2/transactions/simulate', echoSimulate(), true)
        const [outcome] = await algorand.query.groups([compose()], options)
        expect(outcome.via).toBe('simulate')
        expect(simulates()).toHaveLength(1)
        expect(sentSimulate(simulates()[0]).allowEmptySignatures).toBe(true)
        await expect(algorand.query.groups([compose()], { ...options, via: 'query' })).rejects.toThrow()
        expect(queries(stub)).toHaveLength(0)
      })

      test('a fork without the query feature', async () => {
        queryLimitsOk(stub).on('post', '/v2/transactions/simulate', echoSimulate(), true)
        await withoutFeatures(['query'], async () => {
          const [outcome] = await algorand.query.groups([ghost()])
          expect(outcome.via).toBe('simulate')
          await expect(algorand.query.groups([ghost()], { via: 'query' })).rejects.toThrow(DTNotAvailableError)
        })
        expect(queries(stub)).toHaveLength(0)
      })

      test('via query on a node without queries throws DTUnsupportedError; a 404 mid-way falls back with auto', async () => {
        limitsOk(stub)
        expect(isDTUnsupportedError(await algorand.query.groups([ghost()], { via: 'query' }).catch((e) => e))).toBe(true)
        stub = new StubClient()
        algorand = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(stub, '') })
        stub
          .on('get', '/v2/transactions/params', suggestedParams, true)
          .on('post', '/v2/query', () => ({ status: 404, json: { message: 'Not Found' } }), true)
          .on('post', '/v2/transactions/simulate', echoSimulate(), true)
        queryLimitsOk(stub)
        const [outcome] = await algorand.query.groups([ghost()])
        expect(outcome.via).toBe('simulate')
        expect(queries(stub)).toHaveLength(1)
        expect(isDTUnsupportedError(await algorand.query.groups([ghost()], { via: 'query' }).catch((e) => e))).toBe(true)
      })

      test('via simulate never queries; parallel groups, with the options passed on', async () => {
        queryLimitsOk(stub).on('get', '/v2/status', nodeStatus).on('post', '/v2/transactions/simulate', echoSimulate(), true)
        const outcomes = await algorand.query.groups([ghost(), ghost()], { via: 'simulate', allowUnnamedResources: true, round: 700 })
        expect(outcomes.map((o) => [o.via, o.ok, o.round])).toEqual([
          ['simulate', true, 700n],
          ['simulate', true, 700n],
        ])
        const [request] = simulates().map(sentSimulate)
        expect(request).toMatchObject({ parallelGroups: true, allowUnnamedResources: true, round: 700n })
        expect(queries(stub)).toHaveLength(0)
      })
    })

    test('both paths give the same outcomes for the same answers', async () => {
      const value = uint64Return(BigInt(LAST_ROUND) + 1n)
      queryLimitsOk(stub)
        .on('get', '/v2/status', nodeStatus, true)
        .on('post', '/v2/query', queryEcho({ abi: true, callError: (arg) => (arg === 'x' ? 'logic eval error: nope' : undefined) }), true)
        .on(
          'post',
          '/v2/transactions/simulate',
          echoSimulate(() => value),
          true,
        )
      const composers = () => [ghost(), appCall(77n), ghost(ghost())]
      const queried = await algorand.query.groups(composers(), { via: 'query' })
      const simulated = await algorand.query.groups(composers(), { via: 'simulate' })
      expect(queried.map((o) => o.via)).toEqual(['query', 'query', 'query'])
      expect(simulated.map((o) => o.via)).toEqual(['simulate', 'simulate', 'simulate'])
      expect(withoutCost(queried)).toEqual(withoutCost(simulated))

      // Failures map kind, failedAt, failureMessage and the message
      stub = new StubClient()
      algorand = AlgorandClient.fromClients({ algod: new algosdk.Algodv2(stub, '') })
      queryLimitsOk(stub).on('get', '/v2/transactions/params', suggestedParams, true)
      stub.on(
        'post',
        '/v2/transactions/simulate',
        echoSimulate(
          () => value,
          (g) => (g === 0 ? 'transaction ABC: logic eval error: nope' : undefined),
        ),
      )
      const [failed] = await algorand.query.groups([ghost()], { via: 'simulate' })
      expect(failed.ok).toBe(false)
      if (!failed.ok) {
        expect(failed.error).toBeInstanceOf(QueryGroupError)
        expect(failed.error).toMatchObject({ kind: 'group', failedAt: [0], failureMessage: 'transaction ABC: logic eval error: nope' })
        expect(failed.error.message).toBe(
          'Querying group 0 at round 50000 failed at transaction 0: transaction ABC: logic eval error: nope',
        )
        expect(failed.error.txns).toEqual([{ logs: [value], error: 'transaction ABC: logic eval error: nope' }])
        expect(failed.error.cause).toMatchObject({ kind: 'group' })
      }
    })

    test('the options are checked the same way on both paths', async () => {
      queryLimitsOk(stub, {}, { 'max-extra-opcode-budget': 1000 })
      for (const via of ['query', 'simulate', 'auto'] as const) {
        await expect(algorand.query.groups([], { via })).rejects.toThrow('No transaction groups to query')
        await expect(algorand.query.rounds(ghost(), [0, 5], { via })).rejects.toThrow(RangeError)
        await expect(algorand.query.groups([ghost()], { via, extraOpcodeBudget: 2000 })).rejects.toThrow(/maxExtraOpcodeBudget 1000/)
        await expect(algorand.query.groups([ghost()], { via, concurrency: 0 })).rejects.toThrow(/concurrency/)
        await expect(algorand.query.groups([algorand.newGroup()], { via })).rejects.toThrow('Transaction group 0 is empty')
        expect(await algorand.query.rounds(ghost(), [], { via })).toEqual([])
      }
      expect(queries(stub)).toHaveLength(0)
      expect(simulates()).toHaveLength(0)
    })
  })
})
