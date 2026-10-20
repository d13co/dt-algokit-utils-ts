import algosdk from 'algosdk'
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
export type OptionalDTFeature = 'validity-window' | 'simulate-protocol'

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
}

/** A request that can be read at a past round. */
export interface RoundRequestLike<T> {
  round(round: Round): this
  do(): Promise<T>
}

/** A box listing request that can be read at a past round. */
export interface BoxesRoundRequestLike extends RoundRequestLike<modelsv2.BoxesResponse> {
  next(nextToken: string | undefined): this
}

/** A `/versions` request. */
export interface VersionsRequestLike<Entry, Response extends { round: bigint; versions: Entry[]; nextToken?: string }> {
  minRound(round: Round): this
  maxRound(round: Round): this
  order(order: VersionsOrder): this
  limit(limit: number): this
  next(nextToken: string | undefined): this
  include(...include: 'values'[]): this
  do(): Promise<Response>
  iterate(): AsyncGenerator<Entry>
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
}

/** A raw box change from algod's box change feed. */
export interface RawBoxChange {
  name: Uint8Array
  deleted: boolean
  value?: Uint8Array
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
}

/** A raw application version from algod. */
export interface RawApplicationVersion {
  round: bigint
  timestamp: number
  deleted: boolean
  application?: modelsv2.Application
}

/** A raw account version from algod. */
export interface RawAccountVersion {
  round: bigint
  timestamp: number
  base?: { deleted: boolean; account?: modelsv2.Account }
  assets?: { assetId: bigint; deleted: boolean; assetHolding?: modelsv2.AssetHolding }[]
  appsLocalState?: { appId: bigint; deleted: boolean; appLocalState?: modelsv2.ApplicationLocalState }[]
  createdAssets?: { assetId: bigint; deleted: boolean; asset?: modelsv2.Asset }[]
  createdApps?: { appId: bigint; deleted: boolean; application?: modelsv2.Application }[]
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
  do(): Promise<DTSimulateResponseLike>
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
  getApplicationBoxesVersions(appId: Round): VersionsRequestLike<RawBoxesVersion, RawVersionsPage<RawBoxesVersion>>
  getApplicationVersions(appId: Round): VersionsRequestLike<RawApplicationVersion, RawVersionsPage<RawApplicationVersion>>
  getAssetVersions(assetId: Round): VersionsRequestLike<RawAssetVersion, RawVersionsPage<RawAssetVersion>>
  accountVersions(account: string | algosdk.Address): VersionsRequestLike<RawAccountVersion, RawVersionsPage<RawAccountVersion>> & {
    exclude(...exclude: AccountVersionsExclude[]): unknown
  }
  accountAssetVersions(
    account: string | algosdk.Address,
    assetId: Round,
  ): VersionsRequestLike<RawAccountVersion, RawVersionsPage<RawAccountVersion>>
  accountApplicationVersions(
    account: string | algosdk.Address,
    appId: Round,
  ): VersionsRequestLike<RawAccountVersion, RawVersionsPage<RawAccountVersion>>
  simulateTransactions(request: modelsv2.SimulateRequest): DTSimulateRequestLike
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
  }
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
