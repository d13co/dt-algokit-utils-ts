import algosdk, { Address } from 'algosdk'
import { ClientManager } from './client-manager'
import {
  DTAlgodLike,
  QueryCallLike,
  QueryCallResultLike,
  QueryLimits,
  QueryResponseLike,
  Round,
  SimulateProtocolOverride,
  chunk,
  getDTSdk,
  getQueryLimits,
  mergeProtocolOverrides,
  offsetProtocolOverride,
  requireDTSdk,
  requireDTSdkFeatures,
} from './dt-support'
import { SimulateManager } from './simulate-manager'

/** The most requests of a query in flight at once, by default. */
export const DEFAULT_QUERY_CONCURRENCY = 4

/** The most bytes of a query request body when the loaded fork doesn't say: dtalgod's fixed limit. */
const DEFAULT_MAX_QUERY_REQUEST_BYTES = 1_000_000

/** Room left in a request body for everything but the calls and the programs (keys, sender, schemas, budget, protocol). */
const QUERY_REQUEST_OVERHEAD_BYTES = 512

/** The most bytes of a round in a request body (a msgpack uint64). */
const QUERY_ROUND_BYTES = 9

/** A call of a query: the app args and references of its app call. The references only matter to programs before v9. */
export interface QueryCallParams {
  /** The app args (`ApplicationArgs`). */
  args?: Uint8Array[]
  /** The accounts array. */
  accounts?: (string | Address)[]
  /** The foreign apps array. */
  foreignApps?: Round[]
  /** The foreign assets array. */
  foreignAssets?: Round[]
  /** The box references: `app` 0 (or the called app's ID) for the called or created app. */
  boxes?: { app: Round; name: Uint8Array }[]
}

/** The state schema of an app created by a query. */
export interface QuerySchema {
  numUint: number
  numByteSlice: number
}

/** A read-only query: one program or one app, called once per call at each round. Exactly one of `program` and `appId`. */
export interface QueryParams {
  /** The approval program each call creates an app with (compiled bytes). */
  program?: Uint8Array
  /** The clear state program of the created apps; the node uses a minimal one when unset. Only with `program`. */
  clearProgram?: Uint8Array
  /** The global state schema of the created apps. Only with `program`. */
  globalSchema?: QuerySchema
  /** The local state schema of the created apps. Only with `program`. */
  localSchema?: QuerySchema
  /** The deployed app each call is a NoOp call of. */
  appId?: Round
  /** The sender of every call. Defaults to the fee sink. */
  sender?: string | Address
  /** The rounds to query at (0 for the latest round): the state as of the end of each round. Defaults to the latest round. Duplicates are queried once. */
  rounds?: Round[]
  /**
   * The protocol of the block after each round, as with simulate's `protocol`: by default `latest` (unlike simulate, which
   * runs the round's own), `round` for the protocol the chain really ran, a consensus version or `vNN`, or `future` (needs
   * the developer API). Each result's `protocolOverride` says how it applied (none with `round`).
   */
  protocol?: string
  /** The opcode budget of each call, inner calls included. Defaults to, and at most, the node's `maxCallBudget`. */
  budget?: number
  /** The calls, each an app call alone in its group. */
  calls: QueryCallParams[]
}

/** Options for running a query. */
export interface QueryRunOptions {
  /** Aborts the query: every request in flight is cancelled, and the node stops working on it. */
  signal?: AbortSignal
  /** The most requests in flight at once (default 4). */
  concurrency?: number
  /** At most this many calls per request. The node's `maxCalls` caps it: set it lower to split more. */
  maxCalls?: number
  /** At most this many rounds per request. The node's `maxRounds` caps it: set it lower to split more. */
  maxRounds?: number
}

/**
 * Why a call of a query has no result:
 * - `round`: the whole round failed (`failureMessage` is the round's error), so no call ran at it;
 * - `call`: the call failed (its program rejected or erred), or its results alone went over the node's response limit or
 *   time limit.
 */
export type QueryCallErrorKind = 'round' | 'call'

/** The failure of one call of a query at one round. */
export class QueryCallError extends Error {
  /** Why the call has no result. */
  public kind: QueryCallErrorKind
  /** The index of the call, in the order given. */
  public callIndex: number
  /** The round of the result: the state as of the end of this round. */
  public round: bigint
  /** The node's message, as it sent it. */
  public failureMessage: string
  /** What the call logged before it failed (none for `round`, or when the node returned no result for it). */
  public logs: Uint8Array[]
  /** The opcode budget the call used before it failed, when the node returned it. */
  public cost?: number

  constructor({
    kind,
    callIndex,
    round,
    failureMessage,
    logs = [],
    cost,
  }: {
    kind: QueryCallErrorKind
    callIndex: number
    round: bigint
    failureMessage: string
    logs?: Uint8Array[]
    cost?: number
  }) {
    super(
      kind === 'round'
        ? `Could not query round ${round}: ${failureMessage}`
        : `Query call ${callIndex} at round ${round} failed: ${failureMessage}`,
    )
    this.name = 'QueryCallError'
    this.kind = kind
    this.callIndex = callIndex
    this.round = round
    this.failureMessage = failureMessage
    this.logs = logs
    this.cost = cost
  }
}

/** The outcome of one call of a query at one round. */
export type QueryCallOutcome = {
  /** The index of the call, in the order given. */
  callIndex: number
  /** The round of the result. */
  round: bigint
} & (
  | {
      ok: true
      /** What the called (or created) app logged; inner apps' logs aren't included. */
      logs: Uint8Array[]
      /** The opcode budget the call used, inner calls included. */
      cost: number
    }
  | { ok: false; error: QueryCallError }
)

/** The results of a query at one round. */
export interface QueryRunResult {
  /** The round: the state as of the end of it. The latest round (0) is resolved to its number. */
  round: bigint
  /**
   * With `protocol` (other than `round`): how it applied at this round. The notes' `hits` give the call index as `group`, and
   * the path from the call (`path[0]` is 0). Merged across the requests the calls were split into.
   */
  protocolOverride?: SimulateProtocolOverride
  /** The outcome of each call, in the order given. */
  calls: QueryCallOutcome[]
}

/** What a query request goes to: a program (with its clear program and schemas) or an app, and the sender. */
interface QueryTarget {
  program?: Uint8Array
  clearProgram?: Uint8Array
  globalSchema?: QuerySchema
  localSchema?: QuerySchema
  appId?: bigint
  sender?: string
}

/** Calls to one target at some rounds. */
interface QueryJob {
  target: QueryTarget
  calls: QueryCallLike[]
  /** Distinct rounds, 0 for the latest */
  rounds: bigint[]
  protocol?: string
  budget?: number
}

/** A call's result, or the node's message for a call that couldn't be answered on its own (`cost` then unknown). */
type CallResult = { logs: Uint8Array[]; cost?: number; error?: string }

/** The results of a job at one of its rounds. */
interface RoundResults {
  /** The round, resolved for 0 */
  round: bigint
  error?: string
  /** The overrides of the requests that held this round, hits offset to the job's call indexes */
  overrides: (SimulateProtocolOverride | undefined)[]
  calls: (CallResult | undefined)[]
}

/** A request of a job: calls `start` to `end` (exclusive) at `rounds` (0 for the latest). */
interface Piece {
  job: number
  start: number
  end: number
  rounds: bigint[]
}

interface QueryRunConfig {
  signal?: AbortSignal
  concurrency: number
  maxCalls: number
  maxRounds: number
}

type DTSdk = ReturnType<typeof requireDTSdk>

/** The HTTP status of an algosdk request error. */
const errorStatus = (error: unknown): number | undefined => {
  const e = error as { status?: unknown; response?: { status?: unknown } } | undefined
  const status = Number(e?.status ?? e?.response?.status)
  return Number.isNaN(status) ? undefined : status
}

/** The text of an algosdk request error: its message and the response body. */
const errorText = (error: unknown): string => {
  const e = error as { message?: string; response?: { text?: string } } | undefined
  return `${e?.message ?? ''} ${e?.response?.text ?? ''}`
}

/** The node's message of an algosdk request error (its JSON `message`), or the error's message. */
const nodeMessage = (error: unknown): string => {
  const e = error as { message?: string; response?: { text?: string } } | undefined
  try {
    const { message } = JSON.parse(e?.response?.text ?? '') as { message?: unknown }
    if (typeof message === 'string' && message) return message
  } catch {
    // not JSON
  }
  return e?.message ?? String(error)
}

const checkPositiveInteger = (name: string, value: number | undefined) => {
  if (value !== undefined && (!Number.isInteger(value) || value < 1))
    throw new RangeError(`${name} must be a positive integer, not ${value}`)
}

/** The fork's query call for a call of a query. */
const toQueryCall = (call: QueryCallParams): QueryCallLike => ({
  ...(call.args ? { args: call.args } : {}),
  ...(call.accounts ? { accounts: call.accounts.map((a) => a.toString()) } : {}),
  ...(call.foreignApps ? { foreignApps: call.foreignApps.map(BigInt) } : {}),
  ...(call.foreignAssets ? { foreignAssets: call.foreignAssets.map(BigInt) } : {}),
  ...(call.boxes ? { boxes: call.boxes.map((b) => ({ app: BigInt(b.app), name: b.name })) } : {}),
})

/**
 * The requests of one top-level query call (`run`, or `groups` / `rounds` on the query path): splits the calls and rounds
 * into requests within the node's limits, sends them with bounded concurrency, splits again what the node finds too large
 * or too slow, and pins the latest round when it is queried in more than one request. The first error that isn't solved
 * by splitting cancels the requests in flight and is thrown.
 */
class QueryRun {
  private readonly controller = new AbortController()
  private failure: { error: unknown } | undefined
  private active = 0
  private readonly waiting: (() => void)[] = []
  private pin: Promise<bigint> | undefined
  private jobs: QueryJob[] = []
  private results: Map<bigint, RoundResults>[] = []

  constructor(
    private readonly algod: algosdk.Algodv2,
    private readonly dtAlgod: DTAlgodLike,
    private readonly tt: DTSdk,
    private readonly limits: QueryLimits,
    private readonly config: QueryRunConfig,
  ) {}

  /** Runs the jobs, returning the results of each job by round (0 for the latest). */
  async execute(jobs: QueryJob[]): Promise<Map<bigint, RoundResults>[]> {
    const { signal } = this.config
    signal?.throwIfAborted()
    const onAbort = () => this.controller.abort(signal!.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      this.jobs = jobs
      this.results = jobs.map(
        (job) =>
          new Map(job.rounds.map((r) => [r, { round: r, overrides: [], calls: new Array<CallResult | undefined>(job.calls.length) }])),
      )
      const pieces = jobs.flatMap((job, j) => this.plan(job, j))
      // Every call must see the same latest block, even if a new one comes in between the requests
      if (pieces.filter((p) => p.rounds.includes(0n)).length > 1) this.pinLatest()
      await Promise.all(pieces.map((p) => this.send(p)))
      return this.results
    } catch (error) {
      throw this.failure ? this.failure.error : error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Splits a job into requests: rounds by `maxRounds`, calls by `maxCalls` and by the request body limit. */
  private plan(job: QueryJob, j: number): Piece[] {
    const roundsPerRequest = Math.max(1, Math.min(this.config.maxRounds, this.limits.maxRounds))
    const callsPerRequest = Math.max(1, Math.min(this.config.maxCalls, this.limits.maxCalls))
    const maxBody = this.tt.MAX_QUERY_REQUEST_BYTES ?? DEFAULT_MAX_QUERY_REQUEST_BYTES
    const { program, clearProgram } = job.target
    const room =
      maxBody -
      (program?.length ?? 0) -
      (clearProgram?.length ?? 0) -
      QUERY_REQUEST_OVERHEAD_BYTES -
      QUERY_ROUND_BYTES * Math.min(roundsPerRequest, job.rounds.length)
    const callRanges: [number, number][] = []
    let start = 0
    let bytes = 0
    job.calls.forEach((call, i) => {
      const size = this.callSize(call)
      if (size > room) {
        throw new Error(
          `Query call ${i} is too large to send: it takes about ${size} bytes, and the request has room for ${Math.max(0, room)}`,
        )
      }
      if (i - start >= callsPerRequest || bytes + size > room) {
        callRanges.push([start, i])
        start = i
        bytes = 0
      }
      bytes += size
    })
    callRanges.push([start, job.calls.length])
    return chunk(job.rounds, roundsPerRequest).flatMap((rounds) => callRanges.map(([start, end]) => ({ job: j, start, end, rounds })))
  }

  /** The encoded size of a call: exact with the fork's model, else an upper estimate. */
  private callSize(call: QueryCallLike): number {
    const QueryCall = this.tt.dtModels.QueryCall
    if (QueryCall) return algosdk.encodeMsgpack(new QueryCall(call)).length
    return (
      64 +
      (call.args ?? []).reduce((n, a) => n + a.length + 5, 0) +
      (call.accounts?.length ?? 0) * 64 +
      ((call.foreignApps?.length ?? 0) + (call.foreignAssets?.length ?? 0)) * 9 +
      (call.boxes ?? []).reduce((n, b) => n + b.name.length + 24, 0)
    )
  }

  /** Resolves the latest round once, for the requests that query it. */
  private pinLatest(): Promise<bigint> {
    if (!this.pin) {
      this.pin = this.algod
        .status()
        .do(undefined, { signal: this.controller.signal })
        .then((s) => s.lastRound)
      this.pin.catch(() => undefined) // awaited where used
    }
    return this.pin
  }

  private async acquire(): Promise<void> {
    if (this.active < this.config.concurrency) {
      this.active++
      return
    }
    // The slot is handed over by release()
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = { error }
    this.controller.abort()
  }

  private async send(piece: Piece): Promise<void> {
    const job = this.jobs[piece.job]
    let response: QueryResponseLike | undefined
    let failed = false
    let error: unknown
    await this.acquire()
    try {
      this.controller.signal.throwIfAborted()
      const latest = this.pin && piece.rounds.includes(0n) ? await this.pin : undefined
      const rounds = latest === undefined ? piece.rounds : piece.rounds.map((r) => (r === 0n ? latest : r))
      let request = this.dtAlgod.query!({
        ...job.target,
        calls: job.calls.slice(piece.start, piece.end),
        ...(job.budget !== undefined ? { budget: job.budget } : {}),
      }).rounds(rounds)
      if (job.protocol) request = request.protocol(job.protocol)
      response = await request.do(undefined, { signal: this.controller.signal })
    } catch (e) {
      failed = true
      error = e
    } finally {
      this.release()
    }
    if (!failed) return this.record(piece, response!)
    const split = this.controller.signal.aborted ? undefined : this.split(piece, error)
    if (!split) {
      this.fail(error)
      throw error
    }
    if (split === 'alone') return await this.recordAlone(piece, error)
    await Promise.all(split.map((p) => this.send(p)))
  }

  /**
   * How to split a request the node refused as too large (results over `maxResponseBytes`, or a body over its limit) or
   * too slow (504): by rounds, then by calls. `alone` when it is one call that can't be split further (at one round, or for
   * the body limit at any number of rounds); undefined for any other error.
   */
  private split(piece: Piece, error: unknown): Piece[] | 'alone' | undefined {
    const status = errorStatus(error)
    const tooLarge = this.tt.isQueryResponseTooLarge
      ? this.tt.isQueryResponseTooLarge(error)
      : status === 400 && /query response too large/.test(errorText(error))
    const bodyTooLarge = status === 400 && /request body too large/.test(errorText(error))
    if (!tooLarge && !bodyTooLarge && status !== 504) return undefined
    if (piece.rounds.length > 1 && !bodyTooLarge) {
      const half = Math.ceil(piece.rounds.length / 2)
      return [
        { ...piece, rounds: piece.rounds.slice(0, half) },
        { ...piece, rounds: piece.rounds.slice(half) },
      ]
    }
    if (piece.end - piece.start > 1) {
      // The latest round would now be queried in two requests
      if (piece.rounds.includes(0n)) this.pinLatest()
      const mid = piece.start + Math.ceil((piece.end - piece.start) / 2)
      return [
        { ...piece, end: mid },
        { ...piece, start: mid },
      ]
    }
    return 'alone'
  }

  private record(piece: Piece, response: QueryResponseLike): void {
    const results = this.results[piece.job]
    response.rounds.forEach((r, i) => {
      const acc = results.get(piece.rounds[i])!
      if (r.round) acc.round = r.round
      if (r.error !== undefined) {
        acc.error ??= r.error
        return
      }
      acc.overrides.push(offsetProtocolOverride(r.protocolOverride, piece.start))
      r.calls.forEach((c: QueryCallResultLike, k) => (acc.calls[piece.start + k] = c))
    })
  }

  /** Records a call that the node couldn't answer even alone, as failed with the node's message at each round of the request. */
  private async recordAlone(piece: Piece, error: unknown): Promise<void> {
    const results = this.results[piece.job]
    // Report the round the call would have run at
    const latest = piece.rounds.includes(0n) ? await this.pinLatest() : undefined
    for (const r of piece.rounds) {
      const acc = results.get(r)!
      if (r === 0n && acc.round === 0n) acc.round = latest!
      for (let k = piece.start; k < piece.end; k++) acc.calls[k] = { logs: [], error: nodeMessage(error) }
    }
  }
}

/**
 * Read-only TEAL queries on dtalgod (`POST /v2/query`): many calls of one program or app, each alone, at many rounds, with
 * their logs and cost. No signatures, fees or minimum balances; every resource is available without references; nothing
 * is written.
 *
 * Needs a version of the time-travel fork of algosdk with the `query` feature and a dtalgod with queries on.
 */
export class QueryManager {
  private _clientManager: ClientManager
  private _simulate: SimulateManager

  /**
   * Create a new query manager.
   * @param clientManager The `ClientManager` client to use for algod
   * @param simulateManager The `SimulateManager` to fall back to
   */
  constructor(clientManager: ClientManager, simulateManager: SimulateManager) {
    this._clientManager = clientManager
    this._simulate = simulateManager
  }

  /**
   * Returns the node's query limits: how many calls and rounds a request may hold, the most budget and log bytes of a
   * call, and the most bytes of a response. `run` keeps to them. Undefined when the node has no queries (stock algod, an
   * older dtalgod, or queries disabled). The limits are asked for once per algod client, with the simulate limits.
   *
   * @returns The node's query limits, if it has queries
   * @throws DTNotAvailableError if the loaded algosdk is not a version of the time-travel fork with the `query` feature
   * @example
   * ```typescript
   * const limits = await algorand.query.limits()
   * if (limits) console.log(limits.maxCalls, limits.maxRounds)
   * ```
   */
  public async limits(): Promise<QueryLimits | undefined> {
    requireDTSdkFeatures('Reading the query limits', ['query'])
    return await getQueryLimits(this._clientManager.algod)
  }

  /**
   * Returns whether queries can be used: the loaded algosdk is a version of the time-travel fork with the `query` feature,
   * and the node reports query limits. Never throws `DTNotAvailableError`.
   *
   * @returns Whether `run` can be used
   * @example
   * ```typescript
   * if (await algorand.query.supported()) { ... }
   * ```
   */
  public async supported(): Promise<boolean> {
    const tt = getDTSdk()
    if (!tt || !(tt.DTAlgodClient.features ?? []).includes('query')) return false
    return (await getQueryLimits(this._clientManager.algod)) !== undefined
  }

  /**
   * Runs read-only calls of one program (each call creates an app running it) or one deployed app (each call is a NoOp
   * call of it) at each round, in as few requests as the node's limits allow.
   *
   * Each call is an app call alone in its group, in the block after the round, on the state that round left: no
   * signatures, fees or minimum balances, every resource available without references, and its writes dropped. A failed
   * call doesn't affect the others.
   *
   * The calls and rounds are split into requests by the node's `maxCalls` and `maxRounds` and by the request body limit,
   * and sent `concurrency` at a time. A request whose results are over the node's `maxResponseBytes`, or that runs over
   * its time limit (504), is split in halves (rounds first) and sent again; a call that is still too large or too slow
   * alone fails on its own (`kind: 'call'`). When the latest round (0) is queried in more than one request, it is
   * resolved first so every call sees the same block. A busy node (503) is retried by the HTTP client of an
   * `AlgorandClient` made from a config (`AlgoHttpClientWithRetry`, honoring `Retry-After`). Any other error (a bad
   * request, a round after the latest one) cancels the requests in flight and is thrown.
   *
   * There is no simulate fallback here; `groups` and `rounds` have one.
   *
   * @param params The program or app, the calls, the rounds and the request options
   * @param options How to send the requests
   * @returns The results at each round, in the order of `rounds` (one, at the latest round, without `rounds`)
   * @throws DTNotAvailableError if the loaded algosdk is not a version of the time-travel fork with the `query` feature
   * @throws The fork's `DTUnsupportedError` if the node has no queries
   * @example
   * ```typescript
   * const program = (await algorand.app.compileTeal('#pragma version 10\nglobal Round\nitob\nlog\nint 1')).compiledBase64ToBytes
   * const results = await algorand.query.run({ program, rounds: [0, 50_000_000], protocol: 'round', calls: [{}] })
   * for (const { round, calls: [call] } of results) if (call.ok) console.log(round, call.logs[0])
   *
   * // A deployed app at the latest round
   * const [{ calls }] = await algorand.query.run({ appId: 760937186n, calls: [{ args: [selector] }] })
   * ```
   */
  public async run(params: QueryParams, options?: QueryRunOptions): Promise<QueryRunResult[]> {
    const tt = requireDTSdkFeatures('Querying', ['query'])
    const { signal, concurrency = DEFAULT_QUERY_CONCURRENCY, maxCalls, maxRounds } = options ?? {}
    signal?.throwIfAborted()
    checkPositiveInteger('concurrency', concurrency)
    checkPositiveInteger('maxCalls', maxCalls)
    checkPositiveInteger('maxRounds', maxRounds)
    const { program, clearProgram, globalSchema, localSchema, appId, sender, protocol, budget, calls } = params
    if (!calls || calls.length === 0) throw new Error('A query needs at least one call')
    const hasProgram = program !== undefined && program.length > 0
    const hasApp = appId !== undefined && BigInt(appId) !== 0n
    if (hasProgram === hasApp) throw new Error('A query needs exactly one of program and appId')
    const nonZero = (schema?: QuerySchema) => schema !== undefined && (schema.numUint !== 0 || schema.numByteSlice !== 0)
    if (hasApp && ((clearProgram !== undefined && clearProgram.length > 0) || nonZero(globalSchema) || nonZero(localSchema))) {
      throw new Error('clearProgram, globalSchema and localSchema need program, not appId')
    }
    const rounds = params.rounds && params.rounds.length > 0 ? params.rounds.map((r) => BigInt(r)) : [0n]
    const negative = rounds.find((r) => r < 0n)
    if (negative !== undefined) throw new RangeError(`Can't query at round ${negative}`)
    // The limits are cached per client and shared, so they are read without the signal
    const limits = await getQueryLimits(this._clientManager.algod)
    if (!limits) {
      throw new tt.DTUnsupportedError(
        'The node has no query endpoint (POST /v2/query): it is stock algod, an older dtalgod, or has queries disabled',
      )
    }
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > limits.maxCallBudget)) {
      throw new RangeError(`budget must be a positive integer of at most the node's maxCallBudget ${limits.maxCallBudget}, not ${budget}`)
    }
    const target: QueryTarget = hasProgram
      ? {
          program,
          ...(clearProgram?.length ? { clearProgram } : {}),
          ...(globalSchema ? { globalSchema } : {}),
          ...(localSchema ? { localSchema } : {}),
        }
      : { appId: BigInt(appId!) }
    if (sender !== undefined) target.sender = sender.toString()
    const job: QueryJob = { target, calls: calls.map(toQueryCall), rounds: [...new Set(rounds)], protocol, budget }
    const [results] = await this.newRun(tt, limits, { signal, concurrency, maxCalls, maxRounds }).execute([job])
    return rounds.map((r) => toRunResult(results.get(r)!, calls.length))
  }

  /** A run of query requests within the node's limits. */
  private newRun(
    tt: DTSdk,
    limits: QueryLimits,
    { signal, concurrency, maxCalls, maxRounds }: { signal?: AbortSignal; concurrency: number; maxCalls?: number; maxRounds?: number },
  ): QueryRun {
    return new QueryRun(this._clientManager.algod, this._clientManager.dtAlgod, tt, limits, {
      signal,
      concurrency,
      maxCalls: maxCalls ?? Infinity,
      maxRounds: maxRounds ?? Infinity,
    })
  }
}

/** The outcome of each call at one round. */
function toRunResult(acc: RoundResults, callCount: number): QueryRunResult {
  const { round, error } = acc
  const protocolOverride = error === undefined ? mergeProtocolOverrides(acc.overrides) : undefined
  const calls = Array.from({ length: callCount }, (_, callIndex): QueryCallOutcome => {
    if (error !== undefined) {
      return { callIndex, round, ok: false, error: new QueryCallError({ kind: 'round', callIndex, round, failureMessage: error }) }
    }
    const c = acc.calls[callIndex]
    if (!c) {
      return {
        callIndex,
        round,
        ok: false,
        error: new QueryCallError({ kind: 'call', callIndex, round, failureMessage: 'the node returned no result for the call' }),
      }
    }
    if (c.error !== undefined) {
      return {
        callIndex,
        round,
        ok: false,
        error: new QueryCallError({ kind: 'call', callIndex, round, failureMessage: c.error, logs: c.logs, cost: c.cost }),
      }
    }
    return { callIndex, round, ok: true, logs: c.logs, cost: c.cost ?? 0 }
  })
  return { round, ...(protocolOverride ? { protocolOverride } : {}), calls }
}
