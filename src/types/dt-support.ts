import algosdk from 'algosdk'
import { Buffer } from 'buffer'
import type { BuiltTransactions } from './composer'
import modelsv2 = algosdk.modelsv2

/**
 * Runtime support for dtalgod (a time-travel algod) through the time-travel fork of algosdk.
 *
 * algokit-utils keeps working with stock algosdk: the fork's `DTAlgodClient` is looked up at runtime, and
 * the features that need it throw a {@link DTNotAvailableError} when it isn't there. The types below describe
 * the parts of the fork that algokit-utils uses, in terms of stock algosdk types, so that the published declarations
 * never reference the fork.
 */

/** The `DTAlgodClient.features` that algokit-utils needs. */
export const REQUIRED_DT_FEATURES = Object.freeze([
  'reads-at-round',
  'versions',
  'simulate-groups',
  'parallel-groups',
  'simulate-rounds',
  'from',
  'group-results',
  'from-transactions',
  'pack-rounds',
] as const)

/** `DTAlgodClient.features` that only some algokit-utils options need, checked when they are used. */
export type OptionalDTFeature =
  'validity-window' | 'simulate-protocol' | 'simulate-limits' | 'query' | 'versions-rounds' | 'versions-keys' | 'versions-pages' | 'holders'

/** Thrown when a time travel or extended simulate feature is used but the loaded algosdk is not the time-travel fork, or a version without it. */
export class DTNotAvailableError extends Error {
  /**
   * @param feature The feature that was used, for the message
   * @param missing The optional features that a loaded fork lacks, if the fork is loaded but too old
   */
  constructor(feature: string, missing: readonly OptionalDTFeature[] = []) {
    super(
      missing.length > 0
        ? `${feature} needs a newer version of the time-travel fork of algosdk: the loaded one does not have the DTAlgodClient features ${missing.join(', ')}. ` +
            'Install a newer fork and make sure the app loads a single copy of algosdk.'
        : `${feature} needs the time-travel fork of algosdk (with DTAlgodClient features ${REQUIRED_DT_FEATURES.join(', ')}), ` +
            'but the loaded algosdk does not have it. Install the fork and make sure the app loads a single copy of algosdk.',
    )
    this.name = 'DTNotAvailableError'
  }
}

/** A round number, as accepted by the time travel options. */
export type Round = number | bigint

/** Options for reading state at a past round. */
export interface AtRoundOptions {
  /**
   * Read the state as of the end of this round instead of the latest round.
   *
   * Needs a time-travel algod (dtalgod) and the time-travel fork of algosdk. A node that can't serve the round
   * throws instead of returning the latest state.
   */
  round?: Round
  /** Aborts the read: passed to fetch, never to the node's support probe. */
  signal?: AbortSignal
}

/** The fetch options (`customOptions`) that carry an abort signal to algosdk's `.do()`, if there is one. */
export const fetchOptions = (options?: { signal?: AbortSignal }): { signal: AbortSignal } | undefined =>
  options?.signal ? { signal: options.signal } : undefined

/** algosdk's `.do(headers, customOptions)`: `customOptions` are fetch options, such as `{ signal }`. */
export type DoArgs = [headers?: Record<string, string>, customOptions?: Record<string, unknown>]

/** A request that can be read at a past round. */
export interface RoundRequestLike<T> {
  round(round: Round): this
  do(...args: DoArgs): Promise<T>
}

/** A box listing request that can be read at a past round. */
export interface BoxesRoundRequestLike extends RoundRequestLike<modelsv2.BoxesResponse> {
  next(nextToken: string | undefined): this
}

/**
 * A `/versions` request. `rounds` needs the fork's `versions-rounds` feature, and `include('keys')` its `versions-keys`
 * feature: they are only called after checking it.
 */
export interface VersionsRequestLike<
  Entry,
  Response extends { round: bigint; versions: Entry[]; nextToken?: string },
  Include extends string = 'values',
> {
  minRound(round: Round): this
  maxRound(round: Round): this
  rounds(rounds: readonly Round[]): this
  order(order: VersionsOrder): this
  limit(limit: number): this
  next(nextToken: string | undefined): this
  include(...include: Include[]): this
  do(...args: DoArgs): Promise<Response>
  iterate(...args: DoArgs): AsyncGenerator<Entry>
}

/** A `/versions` request of application state (global or local), which can include the changed keys. */
export type StateVersionsRequestLike<
  Entry,
  Response extends { round: bigint; versions: Entry[]; nextToken?: string },
> = VersionsRequestLike<Entry, Response, 'values' | 'keys'>

/** A `/versions` request of an app's global state or an account's local state in one app, which can filter by state key. Needs `versions-pages` (see `DTManager`'s key filter). */
export type KeyedVersionsRequestLike<
  Entry,
  Response extends { round: bigint; versions: Entry[]; nextToken?: string },
> = StateVersionsRequestLike<Entry, Response> & { key(key: Uint8Array): unknown }

/** The `/versions` request of an app's boxes, which can filter by box name prefix. Needs `versions-pages` (see `DTManager`'s prefix filter). */
export type BoxesVersionsRequestLike = VersionsRequestLike<RawBoxesVersion, RawVersionsPage<RawBoxesVersion>> & {
  prefix(prefix: Uint8Array): unknown
}

/** The order of a versions listing: oldest first (`asc`) or newest first (`desc`). */
export type VersionsOrder = 'asc' | 'desc'

/** The sub-objects that an account versions listing can leave out. */
export type AccountVersionsExclude = 'all' | 'none' | 'created-apps-params' | 'created-assets-params'

/** A raw box version from algod. */
export interface RawBoxVersion {
  round: bigint
  timestamp: number
  deleted: boolean
  value?: Uint8Array
  changedRound?: bigint
}

/** A raw box change from algod's box change feed. */
export interface RawBoxChange {
  name: Uint8Array
  deleted: boolean
  value?: Uint8Array
  changedRound?: bigint
}

/** A raw entry of algod's box change feed. */
export interface RawBoxesVersion {
  round: bigint
  timestamp: number
  boxes: RawBoxChange[]
}

/** A raw asset version from algod. */
export interface RawAssetVersion {
  round: bigint
  timestamp: number
  deleted: boolean
  asset?: modelsv2.Asset
  changedRound?: bigint
}

/** A raw application version from algod. */
export interface RawApplicationVersion {
  round: bigint
  timestamp: number
  deleted: boolean
  application?: modelsv2.Application
  changedRound?: bigint
  changedKeys?: Uint8Array[]
  keyValue?: modelsv2.TealValue
}

/** A raw account version from algod. */
export interface RawAccountVersion {
  round: bigint
  timestamp: number
  base?: { deleted: boolean; account?: modelsv2.Account; changedRound?: bigint }
  assets?: { assetId: bigint; deleted: boolean; assetHolding?: modelsv2.AssetHolding; changedRound?: bigint }[]
  appsLocalState?: {
    appId: bigint
    deleted: boolean
    appLocalState?: modelsv2.ApplicationLocalState
    changedRound?: bigint
    changedKeys?: Uint8Array[]
    keyValue?: modelsv2.TealValue
  }[]
  createdAssets?: { assetId: bigint; deleted: boolean; asset?: modelsv2.Asset; changedRound?: bigint }[]
  createdApps?: {
    appId: bigint
    deleted: boolean
    application?: modelsv2.Application
    changedRound?: bigint
    changedKeys?: Uint8Array[]
  }[]
}

/** A raw holder of an asset from algod. */
export interface RawAssetHolder {
  address: string
  amount: bigint
  isFrozen: boolean
}

/** A raw page of an asset's holders from algod. */
export interface RawAssetHoldersPage {
  round: bigint
  nextToken?: string
  holders: RawAssetHolder[]
}

/** An asset holders request (`GET /v2/assets/{id}/holders`). Needs the fork's `holders` feature. */
export interface AssetHoldersRequestLike {
  round(round: Round): this
  limit(limit: number): this
  next(nextToken: string | undefined): this
  do(...args: DoArgs): Promise<RawAssetHoldersPage>
  /** Every holder at one round: the first page's round is pinned for the later pages. */
  iterate(...args: DoArgs): AsyncGenerator<RawAssetHolder>
}

/** A raw page of a `/versions` listing. */
export interface RawVersionsPage<Entry> {
  round: bigint
  versions: Entry[]
  nextToken?: string
}

/** The outcome of one group at one round of an extended simulate request. */
export type RawSimulateGroupOutcome = {
  roundIndex: number
  groupIndex: number
  round: bigint
} & (
  | { ok: true; result: modelsv2.SimulateTransactionGroupResult }
  | {
      ok: false
      error: Error & {
        kind: 'round' | 'group' | 'not-simulated' | 'missing'
        failureMessage?: string
        failedAt?: number[]
        result?: modelsv2.SimulateTransactionGroupResult
      }
    }
)

/** A transaction that read data a {@link SimulateProtocolNote} is about. */
export interface SimulateProtocolNoteHit {
  /** The 0-based index of the transaction group. */
  group: number
  /** The path of the transaction in its group, as in `failedAt`. A logic signature's hit has the path of its top-level transaction. */
  path: number[]
}

/**
 * The codes of {@link SimulateProtocolNote}, as of this version. A newer node may send others.
 * - `semantics-changed`: consensus parameters that affect transactions differ; the message lists each, old → new
 * - `no-heartbeat-challenges`: no heartbeat challenge applies, since earlier challenge rounds ran other rules
 * - `no-load-history`: a congestion tax computed from a load of 0
 * - `block-incentive-fields`: `block` read an incentive field of a round without incentives, which reads as zero
 * - `block-hash-fields`: `block` read a SHA-512 or SHA-256 header field of a round that did not compute it, which reads as zero bytes
 * - `online-stake-includes-expired`: `online_stake` included keys that expire before the simulated round
 * - `account-incentive-fields`: an account incentive field read before incentives, which reads as false or 0
 * - `app-version-starts-at-upgrade`: `AppVersion` counts from the upgrade on
 */
export type SimulateProtocolNoteCode =
  | 'semantics-changed'
  | 'no-heartbeat-challenges'
  | 'no-load-history'
  | 'block-incentive-fields'
  | 'block-hash-fields'
  | 'online-stake-includes-expired'
  | 'account-incentive-fields'
  | 'app-version-starts-at-upgrade'

/** A note about simulating under a later protocol: where the simulation differs from what the chain recorded, or read data the chain never produced. */
export interface SimulateProtocolNote {
  /** What the note is about: a {@link SimulateProtocolNoteCode}. */
  code: SimulateProtocolNoteCode | (string & {})
  /** The note, for people. */
  message: string
  /**
   * The transactions that read the data the note is about: up to 16 per note from each request (more when parallel groups
   * were split across requests). Undefined for notes about the protocol change as a whole.
   */
  hits?: SimulateProtocolNoteHit[]
}

/** How a simulate request's `protocol` applied to the simulated round. */
export interface SimulateProtocolOverride {
  /** The protocol the round after the simulated one really ran. */
  from: string
  /** The requested protocol, with aliases (`v42`, `latest`) resolved. */
  to: string
  /** False when `from` is already `to`: the round was simulated as it is. */
  applied: boolean
  /** Where the simulation under `to` differs from what the chain recorded, or read data the chain never produced. Only set when `applied`. */
  notes?: SimulateProtocolNote[]
}

// Helpers shared by the simulate and query managers

/** The order the node lists protocol notes in; codes it adds later go after these. */
export const PROTOCOL_NOTE_ORDER: readonly string[] = [
  'semantics-changed',
  'no-heartbeat-challenges',
  'no-load-history',
  'block-incentive-fields',
  'block-hash-fields',
  'online-stake-includes-expired',
  'account-incentive-fields',
  'app-version-starts-at-upgrade',
]

/**
 * A protocol override with each note hit replaced by `map(hit)`: for results of requests that hold only part of the
 * groups or calls asked for. Notes without hits, and an override without notes, are kept as they are.
 * @param override The override of one request at one round, if any
 * @param map The new hit for a hit of that request
 */
export function mapProtocolOverrideHits(
  override: SimulateProtocolOverride | undefined,
  map: (hit: SimulateProtocolNoteHit) => SimulateProtocolNoteHit,
): SimulateProtocolOverride | undefined {
  if (!override || !override.notes) return override
  return { ...override, notes: override.notes.map((n) => (n.hits ? { ...n, hits: n.hits.map(map) } : n)) }
}

/**
 * A protocol override with the notes' group indexes moved by `offset`: for a request whose first group (or call) is the
 * `offset`th of those asked for.
 */
export function offsetProtocolOverride(
  override: SimulateProtocolOverride | undefined,
  offset: number,
): SimulateProtocolOverride | undefined {
  if (offset === 0) return override
  return mapProtocolOverrideHits(override, (h) => ({ ...h, group: h.group + offset }))
}

/**
 * Merges the protocol overrides of the requests that the groups (or calls) of one round were split across: notes with the
 * same code and message become one with all their hits, in the node's note order, and the override is `applied` if it
 * applied in any request. Undefined when no request has one.
 */
export function mergeProtocolOverrides(overrides: (SimulateProtocolOverride | undefined)[]): SimulateProtocolOverride | undefined {
  const present = overrides.filter((o): o is SimulateProtocolOverride => o !== undefined)
  if (present.length <= 1) return present[0]
  const notes: SimulateProtocolNote[] = []
  for (const n of present.flatMap((o) => o.notes ?? [])) {
    const same = notes.find((m) => m.code === n.code && m.message === n.message)
    if (!same) notes.push({ ...n, ...(n.hits ? { hits: [...n.hits] } : {}) })
    else if (n.hits) same.hits = [...(same.hits ?? []), ...n.hits]
  }
  const rank = (code: string) => (PROTOCOL_NOTE_ORDER.includes(code) ? PROTOCOL_NOTE_ORDER.indexOf(code) : PROTOCOL_NOTE_ORDER.length)
  notes.sort((a, b) => rank(a.code) - rank(b.code)) // stable: unknown codes keep their order
  return { from: present[0].from, to: present[0].to, applied: present.some((o) => o.applied), ...(notes.length ? { notes } : {}) }
}

/** The IDs of built groups' transactions, by the built group, with the group ID they were hashed under. */
const builtTxIds = new WeakMap<BuiltTransactions, { groupId: string; txIds: readonly string[] }>()

/**
 * The base64 group ID and the transaction IDs of a built group, hashed once per group ID. Requests with `rounds` return
 * the same group at every round, and hashing its transactions again for each was a large part of the time spent on the
 * response. The `txIds` array is shared: copy it before handing it out.
 */
export function txIdsOf(built: BuiltTransactions): { groupId: string; txIds: readonly string[] } {
  const groupId = Buffer.from(built.transactions[0].group ?? new Uint8Array()).toString('base64')
  const cached = builtTxIds.get(built)
  if (cached && cached.groupId === groupId) return cached
  const ids = { groupId, txIds: built.transactions.map((t) => t.txID()) }
  builtTxIds.set(built, ids)
  return ids
}

/**
 * Maps `items` with `fn`, at most `concurrency` at a time, keeping the order. The first failure rejects the result; the
 * calls already started run on, and no new one starts after it.
 */
export async function mapConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  let failed = false
  const worker = async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex++
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/** Splits `items` into consecutive chunks of at most `size`. */
export const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * The limits a node places on simulate requests, and the simulate features it allows, as dtalgod reports them
 * (`GET /v2/transactions/simulate/limits`). A node without that endpoint (stock algod, or an older dtalgod) gets stock
 * algod's limits, with `reported` false.
 */
export interface SimulateLimits {
  /** The most transaction groups a request may hold (`MaxAPISimulateGroups`). 1 on stock algod. */
  maxTxnGroups: number
  /** The most entries a request may list in `rounds`, duplicates included (`MaxAPISimulateRounds`). 0: `rounds` is disabled, as on stock algod. */
  maxRounds: number
  /** The most `extraOpcodeBudget`, for each top-level group of a request (`MaxAPISimulateExtraOpcodeBudget`). 320,000 on stock algod. */
  maxExtraOpcodeBudget: number
  /** The factor on the consensus limits on unnamed resources with `allowUnnamedResources` (`SimulateResourceLimitMultiplier`). 1: the consensus limits. */
  resourceLimitMultiplier: number
  /** Whether `round` and `rounds` reach back to genesis (`EnableTimeTravel`). Unknown, and false, when not `reported`. */
  timeTravel: boolean
  /** Whether requests may set `execTraceConfig` and the protocol `future` (`EnableDeveloperAPI`). Unknown, and false, when not `reported`. */
  developerApi: boolean
  /** Whether the node reported these limits. False when it has no limits endpoint: these are then stock algod's limits. */
  reported: boolean
  /** The limits of read-only queries (`POST /v2/query`): present only when the node has queries. */
  query?: QueryLimits
}

/** The limits a node places on read-only queries (`POST /v2/query`), as dtalgod reports them in its simulate limits. */
export interface QueryLimits {
  /** The most calls a request may hold (`MaxAPIQueryCalls`). */
  maxCalls: number
  /** The most opcode budget of a call, and its budget when the request sets none (`MaxAPIQueryCallBudget`). */
  maxCallBudget: number
  /** The most bytes each program of a call may log, in up to 2,048 logs. 0: the protocol's limits, 1,024 bytes in 32 logs (`MaxAPIQueryCallLogBytes`). */
  maxCallLogBytes: number
  /**
   * The most bytes of logs and errors a request may return, across its calls and rounds (a round listed twice counts
   * twice, each log 48 bytes more than its length). 0: no limit (`MaxAPIQueryResponseBytes`).
   */
  maxResponseBytes: number
  /** The most entries a request may list in `rounds`, duplicates included (`MaxAPIQueryRounds`). */
  maxRounds: number
}

/** A call of a query request, as the fork's `QueryCallParams`. */
export interface QueryCallLike {
  args?: Uint8Array[]
  accounts?: string[]
  foreignApps?: bigint[]
  foreignAssets?: bigint[]
  boxes?: { app: bigint; name: Uint8Array }[]
}

/** A query request, as the fork's `QueryRequestParams`. */
export interface QueryRequestParamsLike {
  program?: Uint8Array
  clearProgram?: Uint8Array
  globalSchema?: { numUint: number; numByteSlice: number }
  localSchema?: { numUint: number; numByteSlice: number }
  appId?: bigint
  sender?: string
  rounds?: bigint[]
  protocol?: string
  budget?: number
  calls: QueryCallLike[]
}

/** The result of one call of a query at one round. */
export interface QueryCallResultLike {
  logs: Uint8Array[]
  cost: number
  error?: string
}

/** The response of a query request: one round result per requested round, in order. */
export interface QueryResponseLike {
  lastRound: bigint
  rounds: { round: bigint; error?: string; protocolOverride?: SimulateProtocolOverride; calls: QueryCallResultLike[] }[]
}

/** A query request (`POST /v2/query`). */
export interface RunQueryLike {
  rounds(rounds: Round[]): this
  protocol(protocol: string): this
  do(...args: DoArgs): Promise<QueryResponseLike>
}

/** The response of an extended simulate request. */
export interface DTSimulateResponseLike extends modelsv2.SimulateResponse {
  roundResults?: {
    lastRound: bigint
    txnGroups: modelsv2.SimulateTransactionGroupResult[]
    protocolOverride?: SimulateProtocolOverride
    error?: string
  }[]
  protocolOverride?: SimulateProtocolOverride
  groupResult(groupIndex: number, roundIndex?: number): RawSimulateGroupOutcome
  groupResults(groupCount?: number): RawSimulateGroupOutcome[][]
}

/** An extended simulate request. */
export interface DTSimulateRequestLike {
  parallelGroups(parallelGroups?: boolean): this
  rounds(rounds: Round[]): this
  skipValidityWindow(skipValidityWindow?: boolean): this
  rewriteValidityWindow(rewriteValidityWindow?: boolean): this
  protocol(protocol: string): this
  do(...args: DoArgs): Promise<DTSimulateResponseLike>
}

/** The parts of the fork's `DTAlgodClient` that algokit-utils uses. */
export interface DTAlgodLike {
  supportsDT(): Promise<boolean>
  accountInformation(account: string | algosdk.Address): RoundRequestLike<modelsv2.Account> & { exclude(exclude: string): unknown }
  accountAssetInformation(account: string | algosdk.Address, assetId: Round): RoundRequestLike<modelsv2.AccountAssetResponse>
  accountApplicationInformation(account: string | algosdk.Address, appId: Round): RoundRequestLike<modelsv2.AccountApplicationResponse>
  getAssetByID(assetId: Round): RoundRequestLike<modelsv2.Asset>
  getApplicationByID(appId: Round): RoundRequestLike<modelsv2.Application>
  getApplicationBoxByName(appId: Round, name: Uint8Array): RoundRequestLike<modelsv2.Box>
  getApplicationBoxes(appId: Round): BoxesRoundRequestLike
  getApplicationBoxVersions(appId: Round, name: Uint8Array): VersionsRequestLike<RawBoxVersion, RawVersionsPage<RawBoxVersion>>
  getApplicationBoxesVersions(appId: Round): BoxesVersionsRequestLike
  getApplicationVersions(appId: Round): KeyedVersionsRequestLike<RawApplicationVersion, RawVersionsPage<RawApplicationVersion>>
  getAssetVersions(assetId: Round): VersionsRequestLike<RawAssetVersion, RawVersionsPage<RawAssetVersion>>
  accountVersions(account: string | algosdk.Address): StateVersionsRequestLike<RawAccountVersion, RawVersionsPage<RawAccountVersion>> & {
    exclude(...exclude: AccountVersionsExclude[]): unknown
  }
  accountAssetVersions(
    account: string | algosdk.Address,
    assetId: Round,
  ): VersionsRequestLike<RawAccountVersion, RawVersionsPage<RawAccountVersion>>
  accountApplicationVersions(
    account: string | algosdk.Address,
    appId: Round,
  ): KeyedVersionsRequestLike<RawAccountVersion, RawVersionsPage<RawAccountVersion>>
  /** The holders of an asset at a round. Only in forks with the `holders` feature. */
  getAssetHolders?(assetId: Round): AssetHoldersRequestLike
  simulateTransactions(request: modelsv2.SimulateRequest): DTSimulateRequestLike
  /** The node's simulate limits, cached per client; stock algod's after a 404. Only in forks with the `simulate-limits` feature. */
  simulateLimits?(): Promise<SimulateLimits>
  /** A read-only query (`POST /v2/query`). Only in forks with the `query` feature. */
  query?(request: QueryRequestParamsLike): RunQueryLike
}

/** A window of rounds that one extended simulate request covers, from `packSimulateRounds`. */
export interface SimulateRoundsWindowLike {
  rounds: bigint[]
  firstValid: bigint
  lastValid: bigint
}

interface DTAlgodClass {
  features?: readonly string[]
  from(algod: algosdk.Algodv2): DTAlgodLike
}

interface DTSdk {
  DTAlgodClient: DTAlgodClass
  DTUnsupportedError: new (message: string, fields?: { requestedRound?: bigint; returnedRound?: bigint; cause?: unknown }) => Error
  packSimulateRounds(
    rounds: Round[],
    options?: { maxRounds?: number; maxSpan?: number | null },
  ): { windows: SimulateRoundsWindowLike[]; positions: { window: number; roundIndex: number }[] }
  dtModels: {
    DTSimulateRequest: {
      fromTransactions(
        groups: algosdk.Transaction[][],
        fields?: Omit<ConstructorParameters<typeof modelsv2.SimulateRequest>[0], 'txnGroups'> & {
          parallelGroups?: boolean
          rounds?: Round[]
        },
      ): modelsv2.SimulateRequest
    }
    /** Only in forks with the `query` feature. */
    QueryCall?: new (call: QueryCallLike) => algosdk.Encodable
  }
  /** Whether an error of a query request means its results are over the node's `maxResponseBytes`. Only in forks with the `query` feature. */
  isQueryResponseTooLarge?(error: unknown): boolean
  /** The most bytes of a query request body. Only in forks with the `query` feature. */
  MAX_QUERY_REQUEST_BYTES?: number
}

const sdk = algosdk as unknown as Partial<DTSdk>

/** Returns the parts of the time-travel fork of algosdk that algokit-utils uses, or `undefined` with stock algosdk. */
export function getDTSdk(): DTSdk | undefined {
  const features = sdk.DTAlgodClient?.features
  if (!features || !REQUIRED_DT_FEATURES.every((f) => features.includes(f))) return undefined
  if (!sdk.packSimulateRounds || !sdk.dtModels?.DTSimulateRequest?.fromTransactions) return undefined
  return sdk as DTSdk
}

/** Returns the parts of the time-travel fork of algosdk that algokit-utils uses, or throws a {@link DTNotAvailableError}. */
export function requireDTSdk(feature: string): DTSdk {
  const tt = getDTSdk()
  if (!tt) throw new DTNotAvailableError(feature)
  return tt
}

/**
 * Like {@link requireDTSdk}, but also needs the given optional `DTAlgodClient.features` of a later version of the fork.
 * @throws DTNotAvailableError if the loaded algosdk is not the time-travel fork, or a version without these features
 */
export function requireDTSdkFeatures(feature: string, optional: readonly OptionalDTFeature[]): DTSdk {
  const tt = requireDTSdk(feature)
  const features = tt.DTAlgodClient.features ?? []
  const missing = optional.filter((f) => !features.includes(f))
  if (missing.length > 0) throw new DTNotAvailableError(feature, missing)
  return tt
}

/**
 * Returns a time-travel algod client that shares the connection (server, token, headers and HTTP client) of the given
 * algod client. The same client is returned for the same `algod`, so its cached time travel probe is kept.
 *
 * @param algod The algod client to share the connection of
 * @param feature The feature that needs the client, for the error message
 * @throws DTNotAvailableError if the loaded algosdk is not the time-travel fork
 */
export function toDTAlgod(algod: algosdk.Algodv2, feature = 'This feature'): DTAlgodLike {
  return requireDTSdk(feature).DTAlgodClient.from(algod)
}

/**
 * Returns the node's simulate limits, through the fork's cached `DTAlgodClient.simulateLimits()`: stock algod's limits
 * (`reported` false) if the node has no limits endpoint. Returns `undefined` when the loaded algosdk is not the
 * time-travel fork, or a version without the `simulate-limits` feature, so the limits are unknown.
 * @param algod The algod client to ask
 * @throws The request's error, other than a 404
 */
export async function getSimulateLimits(algod: algosdk.Algodv2): Promise<SimulateLimits | undefined> {
  const tt = getDTSdk()
  if (!tt || !(tt.DTAlgodClient.features ?? []).includes('simulate-limits')) return undefined
  const client = tt.DTAlgodClient.from(algod)
  if (!client.simulateLimits) return undefined
  // A copy: the fork's object is shared by every caller of the client
  const { maxTxnGroups, maxRounds, maxExtraOpcodeBudget, resourceLimitMultiplier, timeTravel, developerApi, reported, query } =
    await client.simulateLimits()
  return {
    maxTxnGroups,
    maxRounds,
    maxExtraOpcodeBudget,
    resourceLimitMultiplier,
    timeTravel,
    developerApi,
    reported: reported === true,
    // Only when present, so the limits of a node without queries have no `query` key
    ...(query
      ? {
          query: {
            maxCalls: query.maxCalls,
            maxCallBudget: query.maxCallBudget,
            maxCallLogBytes: query.maxCallLogBytes,
            maxResponseBytes: query.maxResponseBytes,
            maxRounds: query.maxRounds,
          },
        }
      : {}),
  }
}

/**
 * Returns the node's query limits (`query` of its simulate limits), or `undefined` when the node has no queries (stock
 * algod, an older dtalgod, or queries disabled) or the loaded algosdk is not a version of the time-travel fork with the
 * `query` feature.
 * @param algod The algod client to ask
 * @throws The limits request's error, other than a 404
 */
export async function getQueryLimits(algod: algosdk.Algodv2): Promise<QueryLimits | undefined> {
  const tt = getDTSdk()
  if (!tt || !(tt.DTAlgodClient.features ?? []).includes('query')) return undefined
  return (await getSimulateLimits(algod))?.query
}

/**
 * Returns whether an error is the fork's `DTUnsupportedError`: the node answered without time travel, or for a
 * different round than the one asked for.
 */
export function isDTUnsupportedError(error: unknown): boolean {
  const ctor = sdk.DTUnsupportedError
  return (ctor !== undefined && error instanceof ctor) || (error instanceof Error && error.name === 'DTUnsupportedError')
}

/**
 * Returns a time-travel algod client for a read at a past round, after checking that the node supports time travel
 * when `checkSupport` is set. Use `checkSupport` for reads whose response has no round to check, such as asset and
 * application lookups, so that a stock node can't silently answer with the latest state.
 */
export async function dtAlgodForRead(algod: algosdk.Algodv2, feature: string, round: Round, checkSupport: boolean): Promise<DTAlgodLike> {
  const tt = requireDTSdk(feature)
  const client = tt.DTAlgodClient.from(algod)
  if (checkSupport && !(await client.supportsDT())) {
    throw new tt.DTUnsupportedError(
      `${feature} at round ${round} needs a time-travel algod (EnableTimeTravel), but the node does not support it`,
      { requestedRound: BigInt(round) },
    )
  }
  return client
}
