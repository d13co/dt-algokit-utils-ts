import algosdk, { Address } from 'algosdk'
import { Buffer } from 'buffer'
import { AccountInformation } from './account'
import { accountInformationFromAlgod } from './account-manager'
import { AppState, BoxName } from './app'
import { AppInformation, AppManager, BoxIdentifier } from './app-manager'
import { AssetInformation, AssetManager } from './asset-manager'
import { ClientManager } from './client-manager'
import {
  AccountVersionsExclude,
  RawAccountVersion,
  RawApplicationVersion,
  RawAssetHolder,
  RawAssetVersion,
  RawBoxesVersion,
  RawBoxVersion,
  Round,
  DTAlgodLike,
  fetchOptions,
  BoxesVersionsRequestLike,
  KeyedVersionsRequestLike,
  RawVersionsPage,
  requireTimeTravel,
  VersionsOrder,
  VersionsRequestLike,
} from './dt-support'

/**
 * The most rounds an iterator sends in one `rounds` request, by default: about 4.5 KB of URL for 8-digit rounds, under
 * the 8 KB request line many proxies allow.
 */
export const DEFAULT_MAX_VERSIONS_ROUNDS_PER_REQUEST = 500

/** Options for a `/versions` listing. */
export interface VersionsOptions {
  /** Include versions at this round or later (inclusive). Defaults to 0. Not with `rounds`. */
  minRound?: Round
  /** Include versions at this round or earlier (inclusive). Defaults to the latest round. A page with an explicit `maxRound` never changes. Not with `rounds`. */
  maxRound?: Round
  /**
   * List the object as of each of these rounds instead of its versions in a range: one entry per distinct round, for the
   * state at the end of that round, with `changedRound`, the round of the change in effect then.
   *
   * - Entries come in `order` (ascending by default), not in the order given: match them by `round`.
   * - An entry with `deleted: true` and no `changedRound` means the object did not exist then.
   * - **Round 0 is the genesis round here**, unlike the `round` option of `algorand.simulate.groups` / `algorand.query.groups`
   *   and the `rounds` of `algorand.query.run`, where 0 is the latest round (`simulate.rounds` and `query.rounds` reject 0).
   * - Not with `minRound` / `maxRound`; `limit` counts rounds.
   * - A page sends the rounds as given, in one request (at most 10,000). The iterators split them into requests of
   *   `min(limit, maxRoundsPerRequest)` rounds, so long lists stay under URL length limits: prefer them for long lists.
   */
  rounds?: readonly Round[]
  /**
   * Iterators only: the most `rounds` sent in one request, default {@link DEFAULT_MAX_VERSIONS_ROUNDS_PER_REQUEST} (500).
   * Each request sends at most `limit` rounds too.
   */
  maxRoundsPerRequest?: number
  /** Oldest first (`asc`, the default) or newest first (`desc`). For the last N changes use `order: 'desc', limit: N`. */
  order?: VersionsOrder
  /**
   * The most versions per page (rounds per page with `rounds`): default 100, at most 10,000, or 1,000 with
   * `includeValues` or `includeKeys`. Pages also end at 1 MB of values (and on the node's other budgets), so they can be
   * short or empty: only a missing `nextToken` means the end. Pass tokens back to the same node.
   */
  limit?: number
  /** Include the value of each version (box values, app params, asset params, account objects). */
  includeValues?: boolean
  /**
   * Aborts the listing: passed to fetch for every page request. An iterator stops at the abort, even within a page, and
   * throws the signal's reason without sending more requests.
   */
  signal?: AbortSignal
}

/** Options for one page of a `/versions` listing. */
export interface VersionsPageOptions extends VersionsOptions {
  /** The `nextToken` of the previous page, with the same other options. */
  next?: string
}

/** Options for the `/versions` listings of application state: an app's (global), an account's and an account's in one app (local). */
export interface AppStateVersionsOptions {
  /**
   * Include `changedKeys`, the state keys each version of global or local state changed (added, removed or given a new
   * value, net over the round), sorted, as bytes.
   */
  includeKeys?: boolean
}

/** Options for the versions of an app's global state, or of an account's local state in one app, that can follow one state key. */
export interface KeyVersionsOptions extends AppStateVersionsOptions {
  /**
   * List only the versions at which this state key changed (added, removed, or a new value or type, net over the round),
   * each with `keyValue`, the key's value after it. A string is UTF-8; at most 64 bytes, and an empty key is valid. On
   * `get/iterateAppVersions` it is a global state key; on `get/iterateAccountAppVersions` a local state key, and the
   * entries then hold only the local state. Not with `rounds`.
   *
   * The node examines a bounded number of versions per page, so pages can be short or empty and still have a
   * `nextToken`: keep paging until it is absent (the iterators do). Needs dt-algosdk (its `versions-pages` feature).
   */
  key?: string | Uint8Array
}

/** Options for an app's box change feed (`get/iterateBoxesVersions`). */
export interface BoxesVersionsOptions {
  /**
   * List only the changes of the boxes whose names start with this prefix, such as one ARC-56 box map. A string is
   * UTF-8; at most 64 bytes. An empty prefix means no filter. In a range, rounds in which none of them changed are left
   * out; with `rounds`, every round has an entry, possibly with no boxes, and only the boxes under the prefix count
   * toward the node's per-round box limit.
   *
   * The node steps through the app's box index, so pages can be short or empty and still have a `nextToken`: keep paging
   * until it is absent (the iterators do). Needs dt-algosdk (its `versions-pages` feature).
   */
  prefix?: string | Uint8Array
}

/** Options for an account `/versions` listing. */
export interface AccountVersionsOptions {
  /** Leave out sub-objects: `all` lists only base account changes; `created-apps-params` / `created-assets-params` leave out the params of created apps / assets. */
  exclude?: AccountVersionsExclude[]
}

/** A page of a `/versions` listing. */
export interface VersionsPage<T> {
  /** The last round the listing covers: `maxRound`, or the latest round when it isn't set. */
  round: bigint
  /** The versions on this page. */
  versions: T[]
  /** Pass as `next` to get the next page; `undefined` on the last page. */
  nextToken?: string
}

/** An account that holds an asset. */
export interface AssetHolder {
  /** The account's address. */
  address: string
  /** Its balance of the asset, in base units. Accounts opted in with a zero balance are listed. */
  amount: bigint
  /** Whether its holding is frozen. */
  frozen: boolean
}

/** A page of an asset's holders, in address order. */
export interface AssetHoldersPage {
  /** The round the holders are listed at: pass it as `round` with `next` for the following pages. */
  round: bigint
  /** The holders on this page. */
  holders: AssetHolder[]
  /** Pass as `next` (with `round`) to get the next page; `undefined` on the last page. Pages can be short or empty and still have one. */
  nextToken?: string
}

/** Options for listing an asset's holders. */
export interface AssetHoldersOptions {
  /** List the holders at this round. Defaults to the latest round. */
  round?: Round
  /** Holders per page: default 1,000, at most 10,000. */
  limit?: number
  /** Aborts the listing: passed to fetch for every page request. */
  signal?: AbortSignal
}

/** Options for one page of an asset's holders. */
export interface AssetHoldersPageOptions extends AssetHoldersOptions {
  /** The `nextToken` of the previous page. Needs `round`: the previous page's `round`, so every page lists the same round. */
  next?: string
}

/** A version of a box: its value as of the end of `round`. */
export interface BoxVersion {
  /** The round the box changed in. */
  round: bigint
  /** The timestamp of that round's block, in seconds since the epoch. */
  timestamp: number
  /** Whether the box was deleted in this round. */
  deleted: boolean
  /** The box value after this round, with `includeValues` (and unless deleted). */
  value?: Uint8Array
  /** With `rounds`: the round of the change in effect at `round`; undefined if the box did not exist then. */
  changedRound?: bigint
}

/** A change to one box, in the app's box change feed. */
export interface BoxChange {
  /** The name of the box. */
  name: BoxName
  /** Whether the box was deleted in this round. */
  deleted: boolean
  /** The box value after this round, with `includeValues` (and unless deleted). */
  value?: Uint8Array
  /** With `rounds`: the round of the box's change in effect at the entry's round. */
  changedRound?: bigint
}

/** The boxes of an app that changed in one round. */
export interface BoxesVersion {
  /** The round the boxes changed in. */
  round: bigint
  /** The timestamp of that round's block, in seconds since the epoch. */
  timestamp: number
  /** The boxes that changed, in name order. */
  boxes: BoxChange[]
}

/** A decoded state value, as in {@link AppState}. */
export type AppStateValue = AppState[string]

/** A version of an app. */
export interface AppVersion {
  /** The round the app changed in. */
  round: bigint
  /** The timestamp of that round's block, in seconds since the epoch. */
  timestamp: number
  /** Whether the app was deleted in this round. */
  deleted: boolean
  /** The app after this round, including its global state, with `includeValues` (and unless deleted). */
  app?: AppInformation
  /** With `rounds`: the round of the change in effect at `round`; undefined if the app did not exist then. */
  changedRound?: bigint
  /**
   * With `includeKeys`: the global state keys changed in this round, as bytes, sorted. `[]` when only other params
   * changed; undefined on deletions or when not asked for.
   */
  changedKeys?: Uint8Array[]
  /** With `key`: the key's value after this round; undefined when the key was removed or the app deleted. */
  keyValue?: AppStateValue
}

/** A version of an asset. */
export interface AssetVersion {
  /** The round the asset changed in. */
  round: bigint
  /** The timestamp of that round's block, in seconds since the epoch. */
  timestamp: number
  /** Whether the asset was destroyed in this round. */
  deleted: boolean
  /** The asset after this round, with `includeValues` (and unless deleted). */
  asset?: AssetInformation
  /** With `rounds`: the round of the change in effect at `round`; undefined if the asset did not exist then. */
  changedRound?: bigint
}

/** A version of an account: what changed in one round. Lists of objects that didn't change are left out. */
export interface AccountVersion {
  /** The round the account changed in. */
  round: bigint
  /** The timestamp of that round's block, in seconds since the epoch. */
  timestamp: number
  /** The account's base record (balance, status, ...), as `exclude: 'all'` account information, if it changed. */
  base?: {
    /** Whether the account was closed in this round. */
    deleted: boolean
    /** The account after this round, with `includeValues` (and unless deleted). */
    account?: AccountInformation
    /** With `rounds`: the round of the change in effect at the entry's round. */
    changedRound?: bigint
  }
  /** Asset holdings that changed. */
  assets?: {
    assetId: bigint
    /** Whether the account opted out of the asset in this round. */
    deleted: boolean
    /** The holding after this round, with `includeValues` (and unless deleted). */
    holding?: { balance: bigint; frozen: boolean }
    /** With `rounds`: the round of the change in effect at the entry's round. */
    changedRound?: bigint
  }[]
  /** App local states that changed. */
  appsLocalState?: {
    appId: bigint
    /** Whether the account opted out of (or cleared) the app in this round. */
    deleted: boolean
    /** The local state after this round, with `includeValues` (and unless deleted). */
    state?: AppState
    /** With `rounds`: the round of the change in effect at the entry's round. */
    changedRound?: bigint
    /** With `includeKeys`: the local state keys changed in this round, as bytes, sorted (`[]` on none; undefined on deletions). */
    changedKeys?: Uint8Array[]
    /** With `key`: the local key's value after this round; undefined when the key was removed or the account opted out. */
    keyValue?: AppStateValue
  }[]
  /** Assets created by the account that changed. */
  createdAssets?: {
    assetId: bigint
    /** Whether the asset was destroyed in this round. */
    deleted: boolean
    /** The asset after this round, with `includeValues` (and unless deleted or excluded). */
    asset?: AssetInformation
    /** With `rounds`: the round of the change in effect at the entry's round. */
    changedRound?: bigint
  }[]
  /** Apps created by the account that changed. */
  createdApps?: {
    appId: bigint
    /** Whether the app was deleted in this round. */
    deleted: boolean
    /** The app after this round, with `includeValues` (and unless deleted or excluded). */
    app?: AppInformation
    /** With `rounds`: the round of the change in effect at the entry's round. */
    changedRound?: bigint
    /** With `includeKeys`: the global state keys changed in this round (undefined on deletions, or with `exclude: ['created-apps-params']`). */
    changedKeys?: Uint8Array[]
  }[]
}

const mapAssetHolder = (h: RawAssetHolder): AssetHolder => ({ address: h.address, amount: h.amount, frozen: h.isFrozen })

const boxName = (name: Uint8Array): BoxName => ({
  nameRaw: name,
  nameBase64: Buffer.from(name).toString('base64'),
  name: Buffer.from(name).toString('utf-8'),
})

const boxNameBytes = (name: BoxIdentifier | BoxName) =>
  AppManager.getBoxReference(typeof name === 'object' && 'nameRaw' in name ? name.nameRaw : name).name

const mapBoxVersion = (v: RawBoxVersion): BoxVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  deleted: v.deleted,
  value: v.value,
  changedRound: v.changedRound,
})

const mapBoxesVersion = (v: RawBoxesVersion): BoxesVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  boxes: v.boxes.map((b) => ({ name: boxName(b.name), deleted: b.deleted, value: b.value, changedRound: b.changedRound })),
})

/** The bytes of a `key` or `prefix` option, checked against the node's 64-byte limit. */
const filterBytes = (what: 'key' | 'prefix', value: string | Uint8Array): Uint8Array => {
  const bytes = typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'utf-8')) : value
  if (bytes.length > MAX_FILTER_BYTES)
    throw new Error(`${what} is ${bytes.length} bytes, longer than the ${MAX_FILTER_BYTES} the node allows`)
  return bytes
}
const MAX_FILTER_BYTES = 64

/** A `keyValue` decoded as {@link AppManager.decodeAppState} decodes state. */
const decodeKeyValue = (key: string | Uint8Array | undefined, value: algosdk.modelsv2.TealValue | undefined): AppStateValue | undefined =>
  key === undefined || value === undefined
    ? undefined
    : Object.values(AppManager.decodeAppState([{ key: filterBytes('key', key), value }]))[0]

const mapAppVersion = (v: RawApplicationVersion, key?: string | Uint8Array): AppVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  deleted: v.deleted,
  app: v.application?.params ? AppManager.appInformationFromAlgod(v.application) : undefined,
  changedRound: v.changedRound,
  changedKeys: v.changedKeys,
  keyValue: decodeKeyValue(key, v.keyValue),
})

const mapAssetVersion = (v: RawAssetVersion): AssetVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  deleted: v.deleted,
  asset: v.asset?.params ? AssetManager.assetInformationFromAlgod(v.asset) : undefined,
  changedRound: v.changedRound,
})

const mapAccountVersion = (v: RawAccountVersion, key?: string | Uint8Array): AccountVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  base: v.base && {
    deleted: v.base.deleted,
    account: v.base.account ? accountInformationFromAlgod(v.base.account) : undefined,
    changedRound: v.base.changedRound,
  },
  assets: v.assets?.map((a) => ({
    assetId: a.assetId,
    deleted: a.deleted,
    holding: a.assetHolding ? { balance: BigInt(a.assetHolding.amount), frozen: a.assetHolding.isFrozen } : undefined,
    changedRound: a.changedRound,
  })),
  appsLocalState: v.appsLocalState?.map((a) => ({
    appId: a.appId,
    deleted: a.deleted,
    state: a.appLocalState ? AppManager.decodeAppState(a.appLocalState.keyValue ?? []) : undefined,
    changedRound: a.changedRound,
    changedKeys: a.changedKeys,
    keyValue: decodeKeyValue(key, a.keyValue),
  })),
  createdAssets: v.createdAssets?.map((a) => ({
    assetId: a.assetId,
    deleted: a.deleted,
    asset: a.asset?.params ? AssetManager.assetInformationFromAlgod(a.asset) : undefined,
    changedRound: a.changedRound,
  })),
  createdApps: v.createdApps?.map((a) => ({
    appId: a.appId,
    deleted: a.deleted,
    app: a.application?.params ? AppManager.appInformationFromAlgod(a.application) : undefined,
    changedRound: a.changedRound,
    changedKeys: a.changedKeys,
  })),
})

type AnyVersionsRequest<E> = VersionsRequestLike<E, { round: bigint; versions: E[]; nextToken?: string }, 'values' | 'keys'>

type AllOptions = VersionsPageOptions & AppStateVersionsOptions

/** Sets a `key` or `prefix` filter on a request, after checking the option. */
type ApplyFilter<E> = (request: AnyVersionsRequest<E>) => void

/** The distinct rounds of `rounds`, in `order`. */
const sortedRounds = (rounds: readonly Round[], order: VersionsOrder | undefined): bigint[] => {
  const distinct = [...new Set(rounds.map((r) => BigInt(r)))]
  return distinct.sort((a, b) => (a === b ? 0 : a < b === (order !== 'desc') ? -1 : 1))
}

/**
 * Time travel on a time-travel algod (dtalgod with `EnableTimeTravel`): the rounds at which boxes, apps, assets and
 * accounts changed, with their values.
 *
 * Needs dt-algosdk (the time-travel fork of algosdk); without it every method throws a `DTNotAvailableError`. A node
 * without time travel (stock algod, or dtalgod with `EnableTimeTravel` off) throws dt-algosdk's `DTUnsupportedError`
 * before any request is sent; whether the node has time travel is read once per algod client, from its capabilities.
 *
 * To read state at a past round, pass `{ round }` to the usual reads (`algorand.app.getGlobalState(appId, { round })`,
 * `algorand.account.getInformation(address, { round })`, ...) or use `appClient.atRound(round)`.
 */
export class DTManager {
  private _clientManager: ClientManager

  /**
   * Create a new time travel manager.
   * @param clientManager The `ClientManager` client to use for algod
   */
  constructor(clientManager: ClientManager) {
    this._clientManager = clientManager
  }

  private get algod(): DTAlgodLike {
    return this._clientManager.dtAlgod
  }

  /**
   * Returns whether time travel can be used: the loaded algosdk is dt-algosdk and the node is dtalgod with time travel
   * on (`EnableTimeTravel`). It is read from the node's capabilities, asked for once per algod client.
   * @returns Whether time travel is supported
   * @example
   * ```typescript
   * if (await algorand.dt.supported()) { ... }
   * ```
   */
  public async supported(): Promise<boolean> {
    return await this._clientManager.supportsDT()
  }

  /**
   * Returns a page of the versions of a box: the rounds at which it changed.
   * @param appId The ID of the app
   * @param name The name of the box
   * @param options The range, order, page size, whether to include values and the `next` token
   * @returns The page of versions
   * @example
   * ```typescript
   * const { versions } = await algorand.dt.getBoxVersions(appId, 'counter', { order: 'desc', limit: 10, includeValues: true })
   * ```
   */
  public async getBoxVersions(
    appId: bigint,
    name: BoxIdentifier | BoxName,
    options?: VersionsPageOptions,
  ): Promise<VersionsPage<BoxVersion>> {
    return await this.page(this.algod.getApplicationBoxVersions(appId, boxNameBytes(name)), options, mapBoxVersion)
  }

  /**
   * Iterates over the versions of a box, following the pages.
   * @param appId The ID of the app
   * @param name The name of the box
   * @param options The range, order, page size and whether to include values
   * @returns The versions
   * @example
   * ```typescript
   * for await (const v of algorand.dt.iterateBoxVersions(appId, 'counter', { includeValues: true })) { ... }
   * ```
   */
  public iterateBoxVersions(appId: bigint, name: BoxIdentifier | BoxName, options?: VersionsOptions): AsyncGenerator<BoxVersion> {
    return this.iterate(() => this.algod.getApplicationBoxVersions(appId, boxNameBytes(name)), options, mapBoxVersion)
  }

  /**
   * Returns a page of an app's box change feed: the rounds at which any of its boxes changed, with the boxes that
   * changed in each.
   * @param appId The ID of the app
   * @param options The range, order, page size, whether to include values and the `next` token
   * @returns The page of versions
   * @example
   * ```typescript
   * const { versions } = await algorand.dt.getBoxesVersions(appId, { minRound: 45_000_000n })
   * ```
   */
  public async getBoxesVersions(appId: bigint, options?: VersionsPageOptions & BoxesVersionsOptions): Promise<VersionsPage<BoxesVersion>> {
    return await this.page(this.algod.getApplicationBoxesVersions(appId), options, mapBoxesVersion, () => this.prefixFilter(options))
  }

  /**
   * Iterates over an app's box change feed, following the pages.
   * @param appId The ID of the app
   * @param options The range, order, page size and whether to include values
   * @returns The versions
   * @example
   * ```typescript
   * for await (const { round, boxes } of algorand.dt.iterateBoxesVersions(appId)) { ... }
   * ```
   */
  public iterateBoxesVersions(appId: bigint, options?: VersionsOptions & BoxesVersionsOptions): AsyncGenerator<BoxesVersion> {
    return this.iterate(
      () => this.algod.getApplicationBoxesVersions(appId),
      options,
      mapBoxesVersion,
      () => this.prefixFilter(options),
    )
  }

  /**
   * Returns a page of the versions of an app (its params and global state).
   * @param appId The ID of the app
   * @param options The range, order, page size, whether to include values and the `next` token
   * @returns The page of versions
   * @example
   * ```typescript
   * const { versions } = await algorand.dt.getAppVersions(appId, { includeValues: true })
   * const counters = versions.map((v) => v.app?.globalState.counter?.value)
   * ```
   */
  public async getAppVersions(appId: bigint, options?: VersionsPageOptions & KeyVersionsOptions): Promise<VersionsPage<AppVersion>> {
    return await this.page(
      this.algod.getApplicationVersions(appId),
      options,
      (v) => mapAppVersion(v, options?.key),
      () => this.keyFilter(options),
    )
  }

  /**
   * Iterates over the versions of an app (its params and global state), following the pages.
   * @param appId The ID of the app
   * @param options The range, order, page size and whether to include values
   * @returns The versions
   * @example
   * ```typescript
   * for await (const v of algorand.dt.iterateAppVersions(appId, { includeValues: true })) { ... }
   * ```
   */
  public iterateAppVersions(appId: bigint, options?: VersionsOptions & KeyVersionsOptions): AsyncGenerator<AppVersion> {
    return this.iterate(
      () => this.algod.getApplicationVersions(appId),
      options,
      (v) => mapAppVersion(v, options?.key),
      () => this.keyFilter(options),
    )
  }

  /**
   * Returns a page of the versions of an asset (its params).
   * @param assetId The ID of the asset
   * @param options The range, order, page size, whether to include values and the `next` token
   * @returns The page of versions
   * @example
   * ```typescript
   * const { versions } = await algorand.dt.getAssetVersions(assetId, { includeValues: true })
   * ```
   */
  public async getAssetVersions(assetId: bigint, options?: VersionsPageOptions): Promise<VersionsPage<AssetVersion>> {
    return await this.page(this.algod.getAssetVersions(assetId), options, mapAssetVersion)
  }

  /**
   * Iterates over the versions of an asset (its params), following the pages.
   * @param assetId The ID of the asset
   * @param options The range, order, page size and whether to include values
   * @returns The versions
   * @example
   * ```typescript
   * for await (const v of algorand.dt.iterateAssetVersions(assetId)) { ... }
   * ```
   */
  public iterateAssetVersions(assetId: bigint, options?: VersionsOptions): AsyncGenerator<AssetVersion> {
    return this.iterate(() => this.algod.getAssetVersions(assetId), options, mapAssetVersion)
  }

  /**
   * Returns a page of the versions of an account: its base record, holdings, local states and created assets and apps.
   * @param address The address of the account
   * @param options The range, order, page size, whether to include values, what to exclude and the `next` token
   * @returns The page of versions
   * @example
   * ```typescript
   * const { versions } = await algorand.dt.getAccountVersions(address, { exclude: ['all'], includeValues: true })
   * const balances = versions.map((v) => v.base?.account?.balance)
   * ```
   */
  public async getAccountVersions(
    address: string | Address,
    options?: VersionsPageOptions & AccountVersionsOptions & AppStateVersionsOptions,
  ): Promise<VersionsPage<AccountVersion>> {
    return await this.page(this.accountVersionsRequest(address, options), options, mapAccountVersion)
  }

  /**
   * Iterates over the versions of an account, following the pages.
   * @param address The address of the account
   * @param options The range, order, page size, whether to include values and what to exclude
   * @returns The versions
   * @example
   * ```typescript
   * for await (const v of algorand.dt.iterateAccountVersions(address, { exclude: ['all'] })) { ... }
   * ```
   */
  public iterateAccountVersions(
    address: string | Address,
    options?: VersionsOptions & AccountVersionsOptions & AppStateVersionsOptions,
  ): AsyncGenerator<AccountVersion> {
    return this.iterate(() => this.accountVersionsRequest(address, options), options, mapAccountVersion)
  }

  /**
   * Returns a page of the versions of an account's holding of one asset.
   * @param address The address of the account
   * @param assetId The ID of the asset
   * @param options The range, order, page size, whether to include values and the `next` token
   * @returns The page of versions
   * @example
   * ```typescript
   * const { versions } = await algorand.dt.getAccountAssetVersions(address, assetId, { includeValues: true })
   * ```
   */
  public async getAccountAssetVersions(
    address: string | Address,
    assetId: bigint,
    options?: VersionsPageOptions,
  ): Promise<VersionsPage<AccountVersion>> {
    return await this.page(this.algod.accountAssetVersions(address, assetId), options, mapAccountVersion)
  }

  /**
   * Iterates over the versions of an account's holding of one asset, following the pages.
   * @param address The address of the account
   * @param assetId The ID of the asset
   * @param options The range, order, page size and whether to include values
   * @returns The versions
   * @example
   * ```typescript
   * for await (const v of algorand.dt.iterateAccountAssetVersions(address, assetId)) { ... }
   * ```
   */
  public iterateAccountAssetVersions(
    address: string | Address,
    assetId: bigint,
    options?: VersionsOptions,
  ): AsyncGenerator<AccountVersion> {
    return this.iterate(() => this.algod.accountAssetVersions(address, assetId), options, mapAccountVersion)
  }

  /**
   * Returns a page of the versions of an account's local state in one app (and of the app, if the account created it).
   * @param address The address of the account
   * @param appId The ID of the app
   * @param options The range, order, page size, whether to include values and the `next` token
   * @returns The page of versions
   * @example
   * ```typescript
   * const { versions } = await algorand.dt.getAccountAppVersions(address, appId, { includeValues: true })
   * ```
   */
  public async getAccountAppVersions(
    address: string | Address,
    appId: bigint,
    options?: VersionsPageOptions & KeyVersionsOptions,
  ): Promise<VersionsPage<AccountVersion>> {
    return await this.page(
      this.algod.accountApplicationVersions(address, appId),
      options,
      (v) => mapAccountVersion(v, options?.key),
      () => this.keyFilter(options),
    )
  }

  /**
   * Iterates over the versions of an account's local state in one app, following the pages.
   * @param address The address of the account
   * @param appId The ID of the app
   * @param options The range, order, page size and whether to include values
   * @returns The versions
   * @example
   * ```typescript
   * for await (const v of algorand.dt.iterateAccountAppVersions(address, appId)) { ... }
   * ```
   */
  public iterateAccountAppVersions(
    address: string | Address,
    appId: bigint,
    options?: VersionsOptions & KeyVersionsOptions,
  ): AsyncGenerator<AccountVersion> {
    return this.iterate(
      () => this.algod.accountApplicationVersions(address, appId),
      options,
      (v) => mapAccountVersion(v, options?.key),
      () => this.keyFilter(options),
    )
  }

  private accountVersionsRequest(address: string | Address, options?: AccountVersionsOptions) {
    const request = this.algod.accountVersions(address)
    if (options?.exclude?.length) request.exclude(...options.exclude)
    return request as AnyVersionsRequest<RawAccountVersion>
  }

  /** Checks the options before anything is sent. */
  private check(options: (VersionsOptions & AppStateVersionsOptions) | undefined) {
    if (options?.rounds && (options.minRound !== undefined || options.maxRound !== undefined)) {
      throw new Error('rounds cannot be combined with minRound or maxRound')
    }
    const max = options?.maxRoundsPerRequest
    if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
      throw new Error(`maxRoundsPerRequest must be a positive integer, not ${max}`)
    }
    // Checked here too, not only by the node: with `rounds`, the iterators split the rounds into chunks of `limit`
    const limit = options?.limit
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
      throw new Error(`limit must be a positive integer, not ${limit}`)
    }
  }

  private configure<E>(
    request: AnyVersionsRequest<E>,
    options: (VersionsOptions & AppStateVersionsOptions) | undefined,
    rounds: readonly Round[] | undefined,
  ) {
    if (options?.minRound !== undefined) request.minRound(options.minRound)
    if (options?.maxRound !== undefined) request.maxRound(options.maxRound)
    if (rounds !== undefined) request.rounds(rounds)
    if (options?.order !== undefined) request.order(options.order)
    if (options?.limit !== undefined) request.limit(options.limit)
    const include = [...(options?.includeValues ? (['values'] as const) : []), ...(options?.includeKeys ? (['keys'] as const) : [])]
    if (include.length) request.include(...include)
    return request
  }

  private async page<E, T>(
    request: VersionsRequestLike<E, RawVersionsPage<E>, never>,
    options: AllOptions | undefined,
    map: (entry: E) => T,
    filter?: () => ApplyFilter<E> | undefined,
  ) {
    this.check(options)
    const apply = filter?.()
    await this.requireTimeTravel('Listing versions')
    const configured = this.configure(request as AnyVersionsRequest<E>, options, options?.rounds)
    apply?.(configured)
    if (options?.next) configured.next(options.next)
    const page = await configured.do(undefined, fetchOptions(options))
    return { round: page.round, versions: page.versions.map(map), nextToken: page.nextToken || undefined }
  }

  private async *iterate<E, T>(
    request: () => VersionsRequestLike<E, RawVersionsPage<E>, never>,
    options: AllOptions | undefined,
    map: (entry: E) => T,
    filter?: () => ApplyFilter<E> | undefined,
  ) {
    const signal = options?.signal
    signal?.throwIfAborted()
    this.check(options)
    const apply = filter?.()
    await this.requireTimeTravel('Listing versions')
    for (const rounds of this.roundsChunks(options)) {
      const configured = this.configure(request() as AnyVersionsRequest<E>, options, rounds)
      apply?.(configured)
      for await (const entry of configured.iterate(undefined, fetchOptions(options))) {
        yield map(entry)
        // The caller may have aborted while it held this entry: stop before reading the rest of the page or the next one
        signal?.throwIfAborted()
      }
    }
  }

  /**
   * Returns a page of the accounts that hold an asset at a round, in address order. Needs dtalgod with time travel and
   * the asset holders index (`TimeTravelHoldersIndex`); otherwise dt-algosdk's `DTUnsupportedError`. An index still being
   * built is a 503 that is thrown at once (not retried). For every holder, prefer {@link iterateAssetHolders}.
   * @param assetId The ID of the asset
   * @param options The round, the page size, the `next` token (with the first page's `round`) and an abort signal
   * @returns The page of holders
   * @example
   * ```typescript
   * const first = await algorand.dt.getAssetHolders(assetId, { limit: 100 })
   * const second = first.nextToken
   *   ? await algorand.dt.getAssetHolders(assetId, { round: first.round, next: first.nextToken, limit: 100 })
   *   : undefined
   * ```
   */
  public async getAssetHolders(assetId: bigint, options?: AssetHoldersPageOptions): Promise<AssetHoldersPage> {
    if (options?.next !== undefined && options.round === undefined) {
      throw new Error("Pass the first page's round with next, so every page of the holders lists the same round")
    }
    await this.requireTimeTravel('Listing asset holders')
    const page = await this.holdersRequest(assetId, options).next(options?.next).do(undefined, fetchOptions(options))
    return { round: page.round, holders: page.holders.map(mapAssetHolder), nextToken: page.nextToken || undefined }
  }

  /**
   * Iterates over the accounts that hold an asset at a round, in address order, following the pages, which all list the
   * first page's round.
   * @param assetId The ID of the asset
   * @param options The round, the page size and an abort signal
   * @returns The holders
   * @example
   * ```typescript
   * let held = 0n
   * for await (const h of algorand.dt.iterateAssetHolders(assetId, { round: 50_000_000n })) held += h.amount
   * ```
   */
  public async *iterateAssetHolders(assetId: bigint, options?: AssetHoldersOptions): AsyncGenerator<AssetHolder> {
    const signal = options?.signal
    signal?.throwIfAborted()
    await this.requireTimeTravel('Listing asset holders')
    for await (const holder of this.holdersRequest(assetId, options).iterate(undefined, fetchOptions(options))) {
      yield mapAssetHolder(holder)
      signal?.throwIfAborted()
    }
  }

  /**
   * Checks that the node has time travel. Stock algod would answer some of these routes with errors of its own; a
   * dtalgod without the holders index rejects the holders request itself with a `DTUnsupportedError`.
   */
  private async requireTimeTravel(feature: string) {
    await requireTimeTravel(this._clientManager.algod, feature)
  }

  private holdersRequest(assetId: bigint, options: AssetHoldersOptions | undefined) {
    const request = this.algod.getAssetHolders(assetId)
    if (options?.round !== undefined) request.round(options.round)
    if (options?.limit !== undefined) request.limit(options.limit)
    return request
  }

  /** The `key` filter of a listing, if any: checked, and set on the request as the node's `key` parameter. */
  private keyFilter<E>(options: (AllOptions & KeyVersionsOptions) | undefined): ApplyFilter<E> | undefined {
    if (options?.key === undefined) return undefined
    const key = filterBytes('key', options.key)
    if (options.rounds) throw new Error('key cannot be combined with rounds')
    return (request) => (request as unknown as KeyedVersionsRequestLike<E, RawVersionsPage<E>>).key(key)
  }

  /** The `prefix` filter of a box change feed, if any: checked, and set on the request as the node's `prefix` parameter. */
  private prefixFilter(options: (AllOptions & BoxesVersionsOptions) | undefined): ApplyFilter<RawBoxesVersion> | undefined {
    if (options?.prefix === undefined) return undefined
    const prefix = filterBytes('prefix', options.prefix)
    // An empty prefix (an ARC-56 map with prefix "") is no filter; the node rejects it
    if (prefix.length === 0) return undefined
    return (request) => (request as unknown as BoxesVersionsRequestLike).prefix(prefix)
  }

  /**
   * The `rounds` of each request an iterator sends: the distinct rounds in `order`, in consecutive chunks of
   * `min(limit, maxRoundsPerRequest)`, so a request carries only the rounds its page can return and the URL stays short.
   * One request without `rounds` when there are none; none for an empty list.
   */
  private roundsChunks(options: VersionsOptions | undefined): (bigint[] | undefined)[] {
    if (!options?.rounds) return [undefined]
    const rounds = sortedRounds(options.rounds, options.order)
    const size = Math.min(options.limit ?? 100, options.maxRoundsPerRequest ?? DEFAULT_MAX_VERSIONS_ROUNDS_PER_REQUEST)
    const chunks: bigint[][] = []
    for (let i = 0; i < rounds.length; i += size) chunks.push(rounds.slice(i, i + size))
    return chunks
  }
}
