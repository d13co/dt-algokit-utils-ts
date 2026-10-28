import { Address } from 'algosdk'
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
  RawAssetVersion,
  RawBoxesVersion,
  RawBoxVersion,
  Round,
  DTAlgodLike,
  fetchOptions,
  VersionsOrder,
  VersionsRequestLike,
} from './dt-support'

/** Options for a `/versions` listing. */
export interface VersionsOptions {
  /** Include versions at this round or later (inclusive). Defaults to 0. */
  minRound?: Round
  /** Include versions at this round or earlier (inclusive). Defaults to the latest round. A page with an explicit `maxRound` never changes. */
  maxRound?: Round
  /** Oldest first (`asc`, the default) or newest first (`desc`). For the last N changes use `order: 'desc', limit: N`. */
  order?: VersionsOrder
  /**
   * The most versions per page: default 100, at most 10,000, or 1,000 with `includeValues`. Pages also end at 1 MB of
   * values, so only a missing `nextToken` means the end.
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
}

/** A change to one box, in the app's box change feed. */
export interface BoxChange {
  /** The name of the box. */
  name: BoxName
  /** Whether the box was deleted in this round. */
  deleted: boolean
  /** The box value after this round, with `includeValues` (and unless deleted). */
  value?: Uint8Array
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
  }
  /** Asset holdings that changed. */
  assets?: {
    assetId: bigint
    /** Whether the account opted out of the asset in this round. */
    deleted: boolean
    /** The holding after this round, with `includeValues` (and unless deleted). */
    holding?: { balance: bigint; frozen: boolean }
  }[]
  /** App local states that changed. */
  appsLocalState?: {
    appId: bigint
    /** Whether the account opted out of (or cleared) the app in this round. */
    deleted: boolean
    /** The local state after this round, with `includeValues` (and unless deleted). */
    state?: AppState
  }[]
  /** Assets created by the account that changed. */
  createdAssets?: {
    assetId: bigint
    /** Whether the asset was destroyed in this round. */
    deleted: boolean
    /** The asset after this round, with `includeValues` (and unless deleted or excluded). */
    asset?: AssetInformation
  }[]
  /** Apps created by the account that changed. */
  createdApps?: {
    appId: bigint
    /** Whether the app was deleted in this round. */
    deleted: boolean
    /** The app after this round, with `includeValues` (and unless deleted or excluded). */
    app?: AppInformation
  }[]
}

const boxName = (name: Uint8Array): BoxName => ({
  nameRaw: name,
  nameBase64: Buffer.from(name).toString('base64'),
  name: Buffer.from(name).toString('utf-8'),
})

const boxNameBytes = (name: BoxIdentifier | BoxName) =>
  AppManager.getBoxReference(typeof name === 'object' && 'nameRaw' in name ? name.nameRaw : name).name

const mapBoxVersion = (v: RawBoxVersion): BoxVersion => ({ round: v.round, timestamp: v.timestamp, deleted: v.deleted, value: v.value })

const mapBoxesVersion = (v: RawBoxesVersion): BoxesVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  boxes: v.boxes.map((b) => ({ name: boxName(b.name), deleted: b.deleted, value: b.value })),
})

const mapAppVersion = (v: RawApplicationVersion): AppVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  deleted: v.deleted,
  app: v.application?.params ? AppManager.appInformationFromAlgod(v.application) : undefined,
})

const mapAssetVersion = (v: RawAssetVersion): AssetVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  deleted: v.deleted,
  asset: v.asset?.params ? AssetManager.assetInformationFromAlgod(v.asset) : undefined,
})

const mapAccountVersion = (v: RawAccountVersion): AccountVersion => ({
  round: v.round,
  timestamp: v.timestamp,
  base: v.base && {
    deleted: v.base.deleted,
    account: v.base.account ? accountInformationFromAlgod(v.base.account) : undefined,
  },
  assets: v.assets?.map((a) => ({
    assetId: a.assetId,
    deleted: a.deleted,
    holding: a.assetHolding ? { balance: BigInt(a.assetHolding.amount), frozen: a.assetHolding.isFrozen } : undefined,
  })),
  appsLocalState: v.appsLocalState?.map((a) => ({
    appId: a.appId,
    deleted: a.deleted,
    state: a.appLocalState ? AppManager.decodeAppState(a.appLocalState.keyValue ?? []) : undefined,
  })),
  createdAssets: v.createdAssets?.map((a) => ({
    assetId: a.assetId,
    deleted: a.deleted,
    asset: a.asset?.params ? AssetManager.assetInformationFromAlgod(a.asset) : undefined,
  })),
  createdApps: v.createdApps?.map((a) => ({
    appId: a.appId,
    deleted: a.deleted,
    app: a.application?.params ? AppManager.appInformationFromAlgod(a.application) : undefined,
  })),
})

type AnyVersionsRequest<E> = VersionsRequestLike<E, { round: bigint; versions: E[]; nextToken?: string }>

/**
 * Time travel on a time-travel algod (dtalgod with `EnableTimeTravel`): the rounds at which boxes, apps, assets and
 * accounts changed, with their values.
 *
 * Needs the time-travel fork of algosdk; without it every method throws a `DTNotAvailableError`. A node without
 * time travel throws the fork's `DTUnsupportedError`.
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
   * Returns whether time travel can be used: the loaded algosdk is the time-travel fork and the node has time travel
   * enabled. The node is probed once per algod client.
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
  public async getBoxesVersions(appId: bigint, options?: VersionsPageOptions): Promise<VersionsPage<BoxesVersion>> {
    return await this.page(this.algod.getApplicationBoxesVersions(appId), options, mapBoxesVersion)
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
  public iterateBoxesVersions(appId: bigint, options?: VersionsOptions): AsyncGenerator<BoxesVersion> {
    return this.iterate(() => this.algod.getApplicationBoxesVersions(appId), options, mapBoxesVersion)
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
  public async getAppVersions(appId: bigint, options?: VersionsPageOptions): Promise<VersionsPage<AppVersion>> {
    return await this.page(this.algod.getApplicationVersions(appId), options, mapAppVersion)
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
  public iterateAppVersions(appId: bigint, options?: VersionsOptions): AsyncGenerator<AppVersion> {
    return this.iterate(() => this.algod.getApplicationVersions(appId), options, mapAppVersion)
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
    options?: VersionsPageOptions & AccountVersionsOptions,
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
    options?: VersionsOptions & AccountVersionsOptions,
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
    options?: VersionsPageOptions,
  ): Promise<VersionsPage<AccountVersion>> {
    return await this.page(this.algod.accountApplicationVersions(address, appId), options, mapAccountVersion)
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
  public iterateAccountAppVersions(address: string | Address, appId: bigint, options?: VersionsOptions): AsyncGenerator<AccountVersion> {
    return this.iterate(() => this.algod.accountApplicationVersions(address, appId), options, mapAccountVersion)
  }

  private accountVersionsRequest(address: string | Address, options?: AccountVersionsOptions) {
    const request = this.algod.accountVersions(address)
    if (options?.exclude?.length) request.exclude(...options.exclude)
    return request as AnyVersionsRequest<RawAccountVersion>
  }

  private configure<E>(request: AnyVersionsRequest<E>, options?: VersionsOptions) {
    if (options?.minRound !== undefined) request.minRound(options.minRound)
    if (options?.maxRound !== undefined) request.maxRound(options.maxRound)
    if (options?.order !== undefined) request.order(options.order)
    if (options?.limit !== undefined) request.limit(options.limit)
    if (options?.includeValues) request.include('values')
    return request
  }

  private async page<E, T>(request: AnyVersionsRequest<E>, options: VersionsPageOptions | undefined, map: (entry: E) => T) {
    this.configure(request, options)
    if (options?.next) request.next(options.next)
    const page = await request.do(undefined, fetchOptions(options))
    return { round: page.round, versions: page.versions.map(map), nextToken: page.nextToken || undefined }
  }

  private async *iterate<E, T>(request: () => AnyVersionsRequest<E>, options: VersionsOptions | undefined, map: (entry: E) => T) {
    const signal = options?.signal
    signal?.throwIfAborted()
    for await (const entry of this.configure(request(), options).iterate(undefined, fetchOptions(options))) {
      yield map(entry)
      // The caller may have aborted while it held this entry: stop before reading the rest of the page or the next one
      signal?.throwIfAborted()
    }
  }
}
