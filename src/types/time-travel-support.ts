import algosdk from 'algosdk'
import modelsv2 = algosdk.modelsv2

/**
 * Runtime support for dtalgod (a time-travel algod) through the time-travel fork of algosdk.
 *
 * algokit-utils keeps working with stock algosdk: the fork's `TimeTravelAlgodClient` is looked up at runtime, and
 * the features that need it throw a {@link TimeTravelNotAvailableError} when it isn't there. The types below describe
 * the parts of the fork that algokit-utils uses, in terms of stock algosdk types, so that the published declarations
 * never reference the fork.
 */

/** The `TimeTravelAlgodClient.features` that algokit-utils needs. */
export const REQUIRED_TIME_TRAVEL_FEATURES = Object.freeze([
  'reads-at-round',
  'versions',
  'simulate-groups',
  'simulate-rounds',
  'from',
  'group-results',
  'from-transactions',
  'pack-rounds',
] as const)

/** Thrown when a time travel or extended simulate feature is used but the loaded algosdk is not the time-travel fork. */
export class TimeTravelNotAvailableError extends Error {
  constructor(feature: string) {
    super(
      `${feature} needs the time-travel fork of algosdk (with TimeTravelAlgodClient features ${REQUIRED_TIME_TRAVEL_FEATURES.join(', ')}), ` +
        'but the loaded algosdk does not have it. Install the fork and make sure the app loads a single copy of algosdk.',
    )
    this.name = 'TimeTravelNotAvailableError'
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

/** The response of an extended simulate request. */
export interface TimeTravelSimulateResponseLike extends modelsv2.SimulateResponse {
  roundResults?: { lastRound: bigint; txnGroups: modelsv2.SimulateTransactionGroupResult[]; error?: string }[]
  groupResult(groupIndex: number, roundIndex?: number): RawSimulateGroupOutcome
  groupResults(groupCount?: number): RawSimulateGroupOutcome[][]
}

/** An extended simulate request. */
export interface TimeTravelSimulateRequestLike {
  parallelGroups(parallelGroups?: boolean): this
  rounds(rounds: Round[]): this
  do(): Promise<TimeTravelSimulateResponseLike>
}

/** The parts of the fork's `TimeTravelAlgodClient` that algokit-utils uses. */
export interface TimeTravelAlgodLike {
  supportsTimeTravel(): Promise<boolean>
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
  simulateTransactions(request: modelsv2.SimulateRequest): TimeTravelSimulateRequestLike
}

/** A window of rounds that one extended simulate request covers, from `packSimulateRounds`. */
export interface SimulateRoundsWindowLike {
  rounds: bigint[]
  firstValid: bigint
  lastValid: bigint
}

interface TimeTravelAlgodClass {
  features?: readonly string[]
  from(algod: algosdk.Algodv2): TimeTravelAlgodLike
}

interface TimeTravelSdk {
  TimeTravelAlgodClient: TimeTravelAlgodClass
  TimeTravelUnsupportedError: new (message: string, fields?: { requestedRound?: bigint; returnedRound?: bigint; cause?: unknown }) => Error
  packSimulateRounds(
    rounds: Round[],
    options?: { maxRounds?: number; maxSpan?: number },
  ): { windows: SimulateRoundsWindowLike[]; positions: { window: number; roundIndex: number }[] }
  timeTravelModels: {
    TimeTravelSimulateRequest: {
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

const sdk = algosdk as unknown as Partial<TimeTravelSdk>

/** Returns the parts of the time-travel fork of algosdk that algokit-utils uses, or `undefined` with stock algosdk. */
export function getTimeTravelSdk(): TimeTravelSdk | undefined {
  const features = sdk.TimeTravelAlgodClient?.features
  if (!features || !REQUIRED_TIME_TRAVEL_FEATURES.every((f) => features.includes(f))) return undefined
  if (!sdk.packSimulateRounds || !sdk.timeTravelModels?.TimeTravelSimulateRequest?.fromTransactions) return undefined
  return sdk as TimeTravelSdk
}

/** Returns the parts of the time-travel fork of algosdk that algokit-utils uses, or throws a {@link TimeTravelNotAvailableError}. */
export function requireTimeTravelSdk(feature: string): TimeTravelSdk {
  const tt = getTimeTravelSdk()
  if (!tt) throw new TimeTravelNotAvailableError(feature)
  return tt
}

/**
 * Returns a time-travel algod client that shares the connection (server, token, headers and HTTP client) of the given
 * algod client. The same client is returned for the same `algod`, so its cached time travel probe is kept.
 *
 * @param algod The algod client to share the connection of
 * @param feature The feature that needs the client, for the error message
 * @throws TimeTravelNotAvailableError if the loaded algosdk is not the time-travel fork
 */
export function toTimeTravelAlgod(algod: algosdk.Algodv2, feature = 'This feature'): TimeTravelAlgodLike {
  return requireTimeTravelSdk(feature).TimeTravelAlgodClient.from(algod)
}

/**
 * Returns whether an error is the fork's `TimeTravelUnsupportedError`: the node answered without time travel, or for a
 * different round than the one asked for.
 */
export function isTimeTravelUnsupportedError(error: unknown): boolean {
  const ctor = sdk.TimeTravelUnsupportedError
  return (ctor !== undefined && error instanceof ctor) || (error instanceof Error && error.name === 'TimeTravelUnsupportedError')
}

/**
 * Returns a time-travel algod client for a read at a past round, after checking that the node supports time travel
 * when `checkSupport` is set. Use `checkSupport` for reads whose response has no round to check, such as asset and
 * application lookups, so that a stock node can't silently answer with the latest state.
 */
export async function timeTravelAlgodForRead(
  algod: algosdk.Algodv2,
  feature: string,
  round: Round,
  checkSupport: boolean,
): Promise<TimeTravelAlgodLike> {
  const tt = requireTimeTravelSdk(feature)
  const client = tt.TimeTravelAlgodClient.from(algod)
  if (checkSupport && !(await client.supportsTimeTravel())) {
    throw new tt.TimeTravelUnsupportedError(
      `${feature} at round ${round} needs a time-travel algod (EnableTimeTravel), but the node does not support it`,
      { requestedRound: BigInt(round) },
    )
  }
  return client
}
