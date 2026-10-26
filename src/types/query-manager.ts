import algosdk, { Address } from 'algosdk'
import { Config } from '../config'
import { getABIReturnValue } from '../transaction/transaction'
import { ABIReturn } from './app'
import { ClientManager } from './client-manager'
import { BuiltTransactions, TransactionComposer } from './composer'
import {
  DTAlgodLike,
  DTNotAvailableError,
  QueryCallLike,
  QueryCallResultLike,
  QueryLimits,
  QueryResponseLike,
  Round,
  SimulateProtocolOverride,
  chunk,
  getDTSdk,
  getQueryLimits,
  getSimulateLimits,
  isDTUnsupportedError,
  mapProtocolOverrideHits,
  mergeProtocolOverrides,
  offsetProtocolOverride,
  requireDTSdk,
  requireDTSdkFeatures,
} from './dt-support'
import {
  SimulateGroupOutcome,
  SimulateGroupsOptions,
  SimulateManager,
  SimulateRoundsOptions,
  checkSimulateLimits,
  simulateOptionFeatures,
} from './simulate-manager'
import modelsv2 = algosdk.modelsv2

/** The most requests of a query in flight at once, by default. */
export const DEFAULT_QUERY_CONCURRENCY = 4

/** The most bytes of a query request body when the loaded fork doesn't say: dtalgod's fixed limit. */
const DEFAULT_MAX_QUERY_REQUEST_BYTES = 1_000_000

/** Room left in a request body for everything but the calls and the programs (keys, sender, schemas, budget, protocol). */
const QUERY_REQUEST_OVERHEAD_BYTES = 512

/** The most bytes of a round in a request body (a msgpack uint64). */
const QUERY_ROUND_BYTES = 9

/** The log bytes a transaction may have with simulate's `allowMoreLogging` (`simulation.LogBytesLimit`). */
const SIMULATE_MORE_LOGGING_BYTES = 65_536

/** The opcode budget of each app call of a group (`MaxAppProgramCost`), pooled. */
const APP_CALL_BUDGET = 700

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

/**
 * Which way `groups` and `rounds` go:
 * - `auto` (the default): query when the node has queries and the groups and options can be queried (see `groups`), else
 *   simulate;
 * - `query`: query, throwing when it can't;
 * - `simulate`: simulate, as `algorand.simulate` with `parallel`.
 */
export type QueryVia = 'auto' | 'query' | 'simulate'

/** How `groups` and `rounds` choose between query and simulate. */
export interface QueryRouting {
  /** Query or simulate (default `auto`). */
  via?: QueryVia
  /** The most query requests in flight at once (default 4). The simulate path sends as `algorand.simulate` does. */
  concurrency?: number
}

/**
 * Options to query groups at one round: those of `algorand.simulate.groups` (except `parallel`: the groups never see each
 * other) and the routing. On the query path, `maxGroups` and `validityWindow` don't apply, and `allowUnnamedResources`
 * is always on.
 */
export type QueryGroupsOptions = Omit<SimulateGroupsOptions, 'parallel'> & QueryRouting

/**
 * Options to query groups at several rounds: those of `algorand.simulate.rounds` (except `parallel`) and the routing. On
 * the query path, `maxRounds` (when more than 0) also caps the rounds per query request.
 */
export type QueryRoundsOptions = Omit<SimulateRoundsOptions, 'parallel'> & QueryRouting

/** The result of a transaction of a queried group. */
export interface QueryTxnResult {
  /** What the transaction's app logged (only the top-level app: inner apps' logs aren't included). Empty for other transactions. */
  logs: Uint8Array[]
  /** The opcode budget the app call used, inner calls included, when the node reported it. */
  cost?: number
}

/**
 * Why a group has no result:
 * - `round`: the whole round failed (`failureMessage` is the round's error);
 * - `group`: a transaction failed (`failedAt`, `failureMessage`);
 * - `not-simulated` (simulate only): the group wasn't run because an earlier group broke the block;
 * - `missing`: the node returned no result for the group.
 */
export type QueryGroupErrorKind = 'round' | 'group' | 'not-simulated' | 'missing'

/** The failure of a group at a round, from `algorand.query.groups` / `rounds`, on either path. */
export class QueryGroupError extends Error {
  /** Why the group has no result. */
  public kind: QueryGroupErrorKind
  /** The index of the group, in the order the composers were given. */
  public groupIndex: number
  /** The round of the result. */
  public round: bigint
  /**
   * The node's message. For a failed transaction, as simulate words it: `transaction <TXID>: logic eval error: ...` (the
   * query path adds the prefix, with the ID of the transaction as built), so `LogicError` can parse it.
   */
  public failureMessage?: string
  /** For `group`: the path of the transaction that failed (on the query path, its index in the group). */
  public failedAt?: number[]
  /**
   * For `group`: the results of the group's transactions, with the failed one's `error`. On the query path every
   * transaction ran and has one; on the simulate path, the ones that ran before the failure.
   */
  public txns?: (QueryTxnResult & { error?: string })[]

  constructor({
    kind,
    groupIndex,
    round,
    failureMessage,
    failedAt,
    txns,
    cause,
  }: {
    kind: QueryGroupErrorKind
    groupIndex: number
    round: bigint
    failureMessage?: string
    failedAt?: number[]
    txns?: (QueryTxnResult & { error?: string })[]
    /** On the simulate path, simulate's error */
    cause?: unknown
  }) {
    const where = `group ${groupIndex} at round ${round}`
    let message: string
    switch (kind) {
      case 'round':
        message = `Could not query ${where}: ${failureMessage}`
        break
      case 'not-simulated':
        message = `Did not query ${where}: ${failureMessage}`
        break
      case 'missing':
        message = `The response has no result for ${where}`
        break
      default:
        message = `Querying ${where} failed${failedAt ? ` at transaction ${failedAt.join('.')}` : ''}: ${failureMessage}`
    }
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'QueryGroupError'
    this.kind = kind
    this.groupIndex = groupIndex
    this.round = round
    this.failureMessage = failureMessage
    this.failedAt = failedAt
    this.txns = txns
  }
}

/** The outcome of one group at one round, from `algorand.query.groups` / `rounds`. */
export type QueryGroupOutcome = {
  /** The index of the group, in the order the composers were given. */
  groupIndex: number
  /** The round of the result: the state as of the end of it. */
  round: bigint
  /**
   * With `protocol`: how it applied at this round, the same for every group of the round. The notes' `hits` give the
   * group index and the path in it. Undefined when the round failed.
   */
  protocolOverride?: SimulateProtocolOverride
  /** Which way the group went. */
  via: 'query' | 'simulate'
} & (
  | {
      ok: true
      /** The result of each transaction of the group, in order. */
      txns: QueryTxnResult[]
      /** The ABI returns of the group's method calls, in order, as `SendAtomicTransactionComposerResults.returns`. */
      returns: ABIReturn[]
    }
  | { ok: false; error: QueryGroupError }
)

/** The outcomes of the groups at one round. */
export interface QueryRoundOutcome {
  /** The round, as given. */
  round: bigint
  /** The outcome of each group, in the order the composers were given. */
  groups: QueryGroupOutcome[]
  /** With `protocol`: how it applied at this round. */
  protocolOverride?: SimulateProtocolOverride
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

  /**
   * Queries composed app calls at one round (the latest by default), with simulate as the fallback: a drop-in for
   * `algorand.simulate.groups(composers, { parallel: true })` for read-only calls.
   *
   * With query, every app call runs alone, against the round's state: the calls of one group don't see each other (no
   * shared budget pool, `global GroupSize` 1, no `gtxn`), and the composers' fees, validity, notes and leases are ignored;
   * each call gets the node's `maxCallBudget`. With simulate, the groups run as composed, each on its own (`parallel`).
   * So use it for independent read-only calls, such as ghost calls. The protocol defaults to `round` (the round's own,
   * as simulate does).
   *
   * `via: 'auto'` (the default) queries when all of these hold, and simulates otherwise:
   * - the fork has the `query` feature and the node reports query limits;
   * - `execTraceConfig` is off;
   * - without `allowMoreLogging`, or with the node's `maxCallLogBytes` at least simulate's 65,536;
   * - with `extraOpcodeBudget`, it plus 700 per transaction is at most `maxCallBudget` for every group;
   * - every transaction is a NoOp app call that creates an app (with an approval program) or calls one (without
   *   programs), without an access list or `rejectVersion`, and no method call has transaction arguments.
   *
   * The options are checked the same way whichever path is taken. A node without queries met mid-way (a load balancer
   * mixing nodes) falls back to simulate with `auto`.
   *
   * Unlike `algorand.simulate.groups`, a round the query can't run at gives `kind: 'round'` outcomes (a bad round still
   * fails the whole request).
   *
   * @param composers The groups, one composer each
   * @param options The simulate options and the routing
   * @returns The outcome of each group, in order
   * @example
   * ```typescript
   * const composer = algorand.newGroup().addAppCreateMethodCall({ sender, method, args, approvalProgram, clearStateProgram, schema })
   * const [outcome] = await algorand.query.groups([composer])
   * if (outcome.ok) console.log(outcome.via, outcome.returns[0]?.returnValue, outcome.txns[0].logs)
   * ```
   */
  public async groups(composers: TransactionComposer[], options?: QueryGroupsOptions): Promise<QueryGroupOutcome[]> {
    const { round, ...rest } = options ?? {}
    const [outcomes] = await this.composed(composers, { round: round ? BigInt(round) : 0n }, rest)
    return outcomes.groups
  }

  /**
   * Queries composed app calls at several past rounds, with simulate as the fallback: a drop-in for
   * `algorand.simulate.rounds(composers, rounds, { parallel: true })` for read-only calls. See `groups` for what query
   * runs and when it is used.
   *
   * @param composers The groups, one composer each (or a single composer)
   * @param rounds The rounds to query at (each > 0): the state as of the end of each round
   * @param options The simulate options and the routing
   * @returns The outcomes at each round, in the order of `rounds`
   * @example
   * ```typescript
   * const composer = algorand.newGroup().addAppCallMethodCall(await appClient.params.call({ method: 'get_price' }))
   * const prices = await algorand.query.rounds(composer, [45_000_000n, 45_001_000n, 45_002_000n])
   * for (const { round, groups: [g] } of prices) if (g.ok) console.log(round, g.returns[0]?.returnValue)
   * ```
   */
  public async rounds(
    composers: TransactionComposer | TransactionComposer[],
    rounds: Round[],
    options?: QueryRoundsOptions,
  ): Promise<QueryRoundOutcome[]> {
    const groups = Array.isArray(composers) ? composers : [composers]
    if (rounds.length === 0) return []
    const requested = rounds.map((r) => BigInt(r))
    const zero = requested.find((r) => r < 1n)
    if (zero !== undefined) {
      throw new RangeError(`Can't query at round ${zero} in rounds: give past rounds (look the latest round up with status())`)
    }
    return await this.composed(groups, { rounds: requested }, options ?? {})
  }

  /** Validates the options, then queries or simulates. */
  private async composed(
    composers: TransactionComposer[],
    at: { round: bigint } | { rounds: bigint[] },
    options: Omit<QueryRoundsOptions, 'round'>,
  ): Promise<QueryRoundOutcome[]> {
    const { via = 'auto', concurrency, ...simulateOptions } = options
    if (via !== 'auto' && via !== 'query' && via !== 'simulate') {
      throw new Error(`via must be 'auto', 'query' or 'simulate', not ${JSON.stringify(via)}`)
    }
    checkPositiveInteger('concurrency', concurrency)
    if (composers.length === 0) throw new Error('No transaction groups to query')
    requireDTSdkFeatures('Querying composed app calls', simulateOptionFeatures(simulateOptions))
    simulateOptions.signal?.throwIfAborted()
    // The limits are cached per client and shared, so they are read without the signal
    checkSimulateLimits(await getSimulateLimits(this._clientManager.algod), simulateOptions.protocol, simulateOptions)
    if (via !== 'simulate') {
      const plan = await this.queryPlan(composers, simulateOptions)
      if (plan.ok) {
        try {
          return await this.viaQuery(plan, at, simulateOptions, concurrency ?? DEFAULT_QUERY_CONCURRENCY)
        } catch (error) {
          if (via === 'query' || !isDTUnsupportedError(error)) throw error
          Config.logger.debug(`Querying through simulate: ${(error as Error).message}`)
        }
      } else {
        if (via === 'query') throw plan.error()
        Config.logger.debug(`Querying through simulate: ${plan.reason}`)
      }
    }
    return await this.viaSimulate(composers, at, simulateOptions)
  }

  /** Whether the groups can be queried with these options, with the built groups if so. */
  private async queryPlan(composers: TransactionComposer[], options: Omit<SimulateRoundsOptions, 'parallel'>): Promise<QueryPlan> {
    const no = (reason: string, error: () => Error = () => new Error(`Can't query these groups: ${reason}`)): QueryPlan => ({
      ok: false,
      reason,
      error,
    })
    const tt = getDTSdk()
    if (!tt) return no('the loaded algosdk is not the time-travel fork', () => new DTNotAvailableError('Querying'))
    if (!(tt.DTAlgodClient.features ?? []).includes('query')) {
      return no('the loaded time-travel fork of algosdk has no query feature', () => new DTNotAvailableError('Querying', ['query']))
    }
    const limits = await getQueryLimits(this._clientManager.algod)
    if (!limits) {
      return no(
        'the node has no query endpoint',
        () =>
          new tt.DTUnsupportedError(
            'The node has no query endpoint (POST /v2/query): it is stock algod, an older dtalgod, or has queries disabled',
          ),
      )
    }
    if (options.execTraceConfig?.enable) return no('execTraceConfig needs simulate')
    if (options.allowMoreLogging && limits.maxCallLogBytes < SIMULATE_MORE_LOGGING_BYTES) {
      return no(`allowMoreLogging allows more log bytes than the node's queries (maxCallLogBytes ${limits.maxCallLogBytes})`)
    }
    const built: BuiltTransactions[] = []
    for (const composer of composers) {
      const b = await composer.buildTransactions()
      if (b.transactions.length === 0) throw new Error(`Transaction group ${built.length} is empty`)
      built.push(b)
    }
    const { extraOpcodeBudget } = options
    for (const [g, b] of built.entries()) {
      if (extraOpcodeBudget !== undefined) {
        const pool = BigInt(extraOpcodeBudget) + BigInt(APP_CALL_BUDGET * b.transactions.length)
        if (pool > BigInt(limits.maxCallBudget)) {
          return no(`group ${g} gets a budget of ${pool} with simulate, more than a query call's maxCallBudget ${limits.maxCallBudget}`)
        }
      }
      for (const [t, txn] of b.transactions.entries()) {
        const why = notQueryable(txn)
        if (why) return no(`transaction ${t} of group ${g} ${why}`)
      }
      for (const [t, method] of b.methodCalls) {
        if (method.args.some((a) => algosdk.abiTypeIsTransaction(a.type))) {
          return no(`the method call at transaction ${t} of group ${g} has transaction arguments`)
        }
      }
    }
    return { ok: true, tt, limits, built }
  }

  /** Queries the groups' app calls: one job per target (program or app, and sender), sharing one run. */
  private async viaQuery(
    plan: Extract<QueryPlan, { ok: true }>,
    at: { round: bigint } | { rounds: bigint[] },
    options: Omit<SimulateRoundsOptions, 'parallel'>,
    concurrency: number,
  ): Promise<QueryRoundOutcome[]> {
    const { tt, limits, built } = plan
    const parts: { target: QueryTarget; calls: QueryCallLike[]; refs: { group: number; txn: number }[] }[] = []
    const where = built.map((b, g) =>
      b.transactions.map((txn, t) => {
        const target = targetOf(txn)
        let part = parts.findIndex((p) => sameTarget(p.target, target))
        if (part < 0) part = parts.push({ target, calls: [], refs: [] }) - 1
        parts[part].calls.push(callOf(txn))
        parts[part].refs.push({ group: g, txn: t })
        return { part, call: parts[part].calls.length - 1 }
      }),
    )
    const requested = 'rounds' in at ? at.rounds : [at.round]
    // Simulate's default: the protocol the round really ran (which reports no override)
    const protocol = options.protocol ?? 'round'
    const run = this.newRun(tt, limits, { signal: options.signal, concurrency, maxRounds: options.maxRounds || undefined })
    const results = await run.execute(parts.map((p) => ({ target: p.target, calls: p.calls, rounds: [...new Set(requested)], protocol })))
    return requested.map((r) => {
      const accs = results.map((m) => m.get(r)!)
      const round = r === 0n ? accs[0].round : r
      const error = accs.find((a) => a.error !== undefined)?.error
      // Hits are at (call index in the part, path from the call): move them to (group, path in the group)
      const protocolOverride =
        error === undefined
          ? mergeProtocolOverrides(
              accs.map((acc, p) =>
                mapProtocolOverrideHits(mergeProtocolOverrides(acc.overrides), (h) => {
                  const ref = parts[p].refs[h.group]
                  return ref ? { group: ref.group, path: [ref.txn, ...h.path.slice(1)] } : h
                }),
              ),
            )
          : undefined
      const groups = built.map((b, g) =>
        toQueryGroupOutcome(
          b,
          g,
          round,
          error,
          where[g].map((w) => accs[w.part].calls[w.call]),
          protocolOverride,
        ),
      )
      return { round, groups, ...(protocolOverride ? { protocolOverride } : {}) }
    })
  }

  /** Simulates the groups in parallel, as `algorand.simulate` does, and maps the outcomes. */
  private async viaSimulate(
    composers: TransactionComposer[],
    at: { round: bigint } | { rounds: bigint[] },
    options: Omit<SimulateRoundsOptions, 'parallel'>,
  ): Promise<QueryRoundOutcome[]> {
    if ('round' in at) {
      const { maxRounds: _maxRounds, validityWindow: _validityWindow, ...rest } = options
      const outcomes = await this._simulate.groups(composers, { ...rest, ...(at.round ? { round: at.round } : {}), parallel: true })
      const protocolOverride = outcomes.find((o) => o.protocolOverride)?.protocolOverride
      return [
        {
          round: outcomes[0]?.round ?? at.round,
          groups: outcomes.map(fromSimulateOutcome),
          ...(protocolOverride ? { protocolOverride } : {}),
        },
      ]
    }
    const results = await this._simulate.rounds(composers, at.rounds, { ...options, parallel: true })
    return results.map((r) => ({
      round: r.round,
      groups: r.groups.map(fromSimulateOutcome),
      ...(r.protocolOverride ? { protocolOverride: r.protocolOverride } : {}),
    }))
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

/** Whether groups can be queried: the built groups and what to query them with, or why not and the error for `via: 'query'`. */
type QueryPlan =
  { ok: true; tt: DTSdk; limits: QueryLimits; built: BuiltTransactions[] } | { ok: false; reason: string; error: () => Error }

/** Why a transaction can't be a query call, or undefined if it can. */
function notQueryable(txn: algosdk.Transaction): string | undefined {
  const app = txn.applicationCall
  if (txn.type !== algosdk.TransactionType.appl || !app) return `is a ${txn.type} transaction, not an app call`
  if (app.onComplete !== algosdk.OnApplicationComplete.NoOpOC) {
    return `has OnComplete ${algosdk.OnApplicationComplete[app.onComplete] ?? app.onComplete}, not NoOp`
  }
  if (app.access.length > 0) return 'has an access list'
  if (app.rejectVersion) return 'sets rejectVersion'
  if (app.appIndex === 0n) return app.approvalProgram.length > 0 ? undefined : 'creates an app without an approval program'
  return app.approvalProgram.length > 0 || app.clearProgram.length > 0 ? 'calls an existing app with programs' : undefined
}

/** The query target of an app call. */
function targetOf(txn: algosdk.Transaction): QueryTarget {
  const app = txn.applicationCall!
  const sender = txn.sender.toString()
  if (app.appIndex !== 0n) return { appId: app.appIndex, sender }
  const schema = (numUint: number, numByteSlice: number) => (numUint || numByteSlice ? { numUint, numByteSlice } : undefined)
  const globalSchema = schema(app.numGlobalInts, app.numGlobalByteSlices)
  const localSchema = schema(app.numLocalInts, app.numLocalByteSlices)
  return {
    program: app.approvalProgram,
    ...(app.clearProgram.length > 0 ? { clearProgram: app.clearProgram } : {}),
    ...(globalSchema ? { globalSchema } : {}),
    ...(localSchema ? { localSchema } : {}),
    sender,
  }
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const sameSchema = (a: QuerySchema | undefined, b: QuerySchema | undefined) =>
  a?.numUint === b?.numUint && a?.numByteSlice === b?.numByteSlice

/** Whether two targets are the same request target. */
function sameTarget(a: QueryTarget, b: QueryTarget): boolean {
  return (
    a.sender === b.sender &&
    a.appId === b.appId &&
    sameSchema(a.globalSchema, b.globalSchema) &&
    sameSchema(a.localSchema, b.localSchema) &&
    sameBytes(a.program, b.program) &&
    sameBytes(a.clearProgram, b.clearProgram)
  )
}

/** The query call of an app call: its args and references. */
function callOf(txn: algosdk.Transaction): QueryCallLike {
  const app = txn.applicationCall!
  return {
    ...(app.appArgs.length ? { args: [...app.appArgs] } : {}),
    ...(app.accounts.length ? { accounts: app.accounts.map((a) => a.toString()) } : {}),
    ...(app.foreignApps.length ? { foreignApps: [...app.foreignApps] } : {}),
    ...(app.foreignAssets.length ? { foreignAssets: [...app.foreignAssets] } : {}),
    ...(app.boxes.length ? { boxes: app.boxes.map((b) => ({ app: b.appIndex, name: b.name })) } : {}),
  }
}

/** The outcome of a queried group from the results of its calls. */
function toQueryGroupOutcome(
  built: BuiltTransactions,
  groupIndex: number,
  round: bigint,
  roundError: string | undefined,
  calls: (CallResult | undefined)[],
  protocolOverride: SimulateProtocolOverride | undefined,
): QueryGroupOutcome {
  const base = { groupIndex, round, via: 'query' as const, ...(protocolOverride ? { protocolOverride } : {}) }
  const fail = (error: QueryGroupError): QueryGroupOutcome => ({ ...base, ok: false, error })
  if (roundError !== undefined) return fail(new QueryGroupError({ kind: 'round', groupIndex, round, failureMessage: roundError }))
  if (calls.some((c) => !c)) return fail(new QueryGroupError({ kind: 'missing', groupIndex, round }))
  const results = calls as CallResult[]
  const txnResult = (c: CallResult) => ({ logs: c.logs, ...(c.cost !== undefined ? { cost: c.cost } : {}) })
  const failed = results.findIndex((c) => c.error !== undefined)
  if (failed >= 0) {
    return fail(
      new QueryGroupError({
        kind: 'group',
        groupIndex,
        round,
        // As simulate words it, for LogicError and other parsers of simulate's messages
        failureMessage: `transaction ${built.transactions[failed].txID()}: ${results[failed].error}`,
        failedAt: [failed],
        txns: results.map((c) => ({ ...txnResult(c), ...(c.error !== undefined ? { error: c.error } : {}) })),
      }),
    )
  }
  const returns = [...built.methodCalls.entries()].map(([index, method]) =>
    getABIReturnValue(
      algosdk.AtomicTransactionComposer.parseMethodResponse(
        method,
        { txID: built.transactions[index].txID(), rawReturnValue: new Uint8Array(), method },
        { logs: results[index].logs } as modelsv2.PendingTransactionResponse,
      ),
      method.returns.type,
    ),
  )
  return { ...base, ok: true, txns: results.map(txnResult), returns }
}

/** The simulate transaction results of a response, by their confirmation (`txnResult`). */
const simulateResults = new WeakMap<object, Map<modelsv2.PendingTransactionResponse, modelsv2.SimulateTransactionResult>>()

function simulateResultsOf(response: modelsv2.SimulateResponse) {
  let results = simulateResults.get(response)
  if (!results) {
    results = new Map()
    const rounds = (response as { roundResults?: { txnGroups: modelsv2.SimulateTransactionGroupResult[] }[] }).roundResults ?? []
    for (const group of [...response.txnGroups, ...rounds.flatMap((r) => r.txnGroups)]) {
      for (const t of group.txnResults) results.set(t.txnResult, t)
    }
    simulateResults.set(response, results)
  }
  return results
}

/** A simulate outcome as a query outcome. */
function fromSimulateOutcome(o: SimulateGroupOutcome): QueryGroupOutcome {
  const { groupIndex, round } = o
  const base = { groupIndex, round, via: 'simulate' as const, ...(o.protocolOverride ? { protocolOverride: o.protocolOverride } : {}) }
  const cost = (t: modelsv2.SimulateTransactionResult | undefined) =>
    t?.appBudgetConsumed !== undefined ? { cost: t.appBudgetConsumed } : {}
  if (o.ok) {
    const results = simulateResultsOf(o.result.simulateResponse)
    return {
      ...base,
      ok: true,
      txns: o.result.confirmations.map((c) => ({ logs: c.logs ?? [], ...cost(results.get(c)) })),
      returns: o.result.returns ?? [],
    }
  }
  const { kind, failureMessage, failedAt, result } = o.error
  const txns = result?.txnResults.map((t, i) => ({
    logs: t.txnResult.logs ?? [],
    ...cost(t),
    ...(failedAt?.[0] === i && failureMessage !== undefined ? { error: failureMessage } : {}),
  }))
  return {
    ...base,
    ok: false,
    error: new QueryGroupError({ kind, groupIndex, round, failureMessage, failedAt, txns, cause: o.error }),
  }
}
