import algosdk, { Address, ProgramSourceMap } from 'algosdk'
import { getABIReturnValue } from '../transaction/transaction'
import { TransactionSignerAccount } from './account'
import {
  BoxName,
  DELETABLE_TEMPLATE_NAME,
  UPDATABLE_TEMPLATE_NAME,
  type ABIReturn,
  type AppState,
  type CompiledTeal,
  type TealTemplateParams,
} from './app'
import { AtRoundOptions, dtAlgodForRead, fetchOptions, mapConcurrently } from './dt-support'
import modelsv2 = algosdk.modelsv2

/** Options for {@link AppManager.getBoxes}. */
export interface GetBoxesOptions extends AtRoundOptions {
  /** Only the boxes whose names start with this prefix (a string is UTF-8). Empty or undefined: every box. */
  prefix?: string | Uint8Array
  /** Include each box's value. */
  includeValues?: boolean
  /** The most boxes per page; the node caps it at its `MaxAPIBoxPerApplication`. Pages also end at about 1 MB of values. */
  limit?: number
}

/** A box of an app, with its value if it was asked for. */
export interface BoxWithValue {
  /** The box's name. */
  name: BoxName
  /** The box's value, with `includeValues`. */
  value?: Uint8Array
}

/** The paged box listing builder of algosdk 3.6 and later (the methods are absent before). */
interface PagedBoxesRequest {
  prefix?(prefix: Uint8Array): unknown
  include?(...include: 'values'[]): unknown
  limit(limit: number): unknown
  next(next: string | undefined): unknown
  do(headers?: Record<string, string>, customOptions?: Record<string, unknown>): Promise<PagedBoxesResponse>
}

/** A box listing: paged (algosdk 3.6+, with `round`) or not. */
interface PagedBoxesResponse {
  round?: bigint
  nextToken?: string
  boxes: { name: Uint8Array; value?: Uint8Array }[]
}

/** Information about an app. */
export interface AppInformation {
  /** The ID of the app. */
  appId: bigint
  /** The escrow address that the app operates with. */
  appAddress: Address
  /**
   * Approval program.
   */
  approvalProgram: Uint8Array
  /**
   * Clear state program.
   */
  clearStateProgram: Uint8Array
  /**
   * The address that created this application. This is the address where the
   * parameters and global state for this application can be found.
   */
  creator: Address
  /**
   * Current global state values.
   */
  globalState: AppState
  /** The number of allocated ints in per-user local state. */
  localInts: number
  /** The number of allocated byte slices in per-user local state. */
  localByteSlices: number
  /** The number of allocated ints in global state. */
  globalInts: number
  /** The number of allocated byte slices in global state. */
  globalByteSlices: number
  /** Any extra pages that are needed for the smart contract. */
  extraProgramPages?: number
  /** The number of updates to the application programs */
  version?: number
}

/**
 * Something that identifies an app box name - either a:
 *  * `Uint8Array` (the actual binary of the box name)
 *  * `string` (that will be encoded to a `Uint8Array`)
 *  * `TransactionSignerAccount` (that will be encoded into the
 *    public key address of the corresponding account)
 */
export type BoxIdentifier = string | Uint8Array | TransactionSignerAccount

/**
 * A grouping of the app ID and name identifier to reference an app box.
 */
export interface BoxReference {
  /**
   * A unique application id
   */
  appId: bigint
  /**
   * Identifier for a box name
   */
  name: BoxIdentifier
}

/**
 * Parameters to get and decode a box value as an ABI type.
 */
export interface BoxValueRequestParams {
  /** The ID of the app return box names for */
  appId: bigint
  /** The name of the box to return either as a string, binary array or `BoxName` */
  boxName: BoxIdentifier
  /** The ABI type to decode the value using */
  type: algosdk.ABIType
  /** Read the box as of the end of this past round instead of the latest round (needs dtalgod time travel) */
  round?: number | bigint
}

/**
 * Parameters to get and decode a box value as an ABI type.
 */
export interface BoxValuesRequestParams {
  /** The ID of the app return box names for */
  appId: bigint
  /** The names of the boxes to return either as a string, binary array or BoxName` */
  boxNames: BoxIdentifier[]
  /** The ABI type to decode the value using */
  type: algosdk.ABIType
  /** Read the boxes as of the end of this past round instead of the latest round (needs dtalgod time travel) */
  round?: number | bigint
}

/**
 * Defines a holding by referring to an Address and Asset it belongs to.
 */
export type HoldingReference = {
  /** Asset ID for asset in access list. */
  assetId: bigint
  /** Address in access list, or the sender of the transaction. */
  address: Address
}

/**
 * Defines a local state by referring to an Address and App it belongs to.
 */
export type LocalsReference = {
  /** Application ID for app in access list, or zero if referring to the called application. */
  appId: bigint
  /** Address in access list, or the sender of the transaction. */
  address: Address
}

/**
 * Names a single resource reference. Only one of the fields should be set.
 */
export type ResourceReference = {
  /** Any account addresses whose balance record is accessible by the executing ApprovalProgram or ClearStateProgram. */
  address?: Address
  /** Application ID whose GlobalState may be read by the executing ApprovalProgram or ClearStateProgram. */
  appId?: bigint
  /** Asset ID whose AssetParams may be read by the executing ApprovalProgram or ClearStateProgram. */
  assetId?: bigint
  /** Defines a holding by referring to an Address and Asset it belongs to. */
  holding?: HoldingReference
  /** Defines a local state by referring to an Address and App it belongs to. */
  locals?: LocalsReference
  /** Defines a box by its name and the application ID it belongs to. */
  box?: BoxReference
}

/** Allows management of application information. */
export class AppManager {
  private _algod: algosdk.Algodv2
  private _compilationResults: Record<string, CompiledTeal> = {}

  /**
   * Creates an `AppManager`
   * @param algod An algod instance
   */
  constructor(algod: algosdk.Algodv2) {
    this._algod = algod
  }

  /**
   * Compiles the given TEAL using algod and returns the result, including source map.
   *
   * The result of this compilation is also cached keyed by the TEAL
   *  code so it can be retrieved via `getCompilationResult`.
   *
   * This function is re-entrant; it will only compile the same code once.
   *
   * @param tealCode The TEAL code
   * @returns The information about the compiled file
   * @example
   * ```typescript
   * const compiled = await appManager.compileTeal(tealProgram)
   * ```
   */
  async compileTeal(tealCode: string): Promise<CompiledTeal> {
    if (this._compilationResults[tealCode]) {
      return this._compilationResults[tealCode]
    }

    const compiled = await this._algod.compile(tealCode).sourcemap(true).do()
    const result = {
      teal: tealCode,
      compiled: compiled.result,
      compiledHash: compiled.hash,
      compiledBase64ToBytes: new Uint8Array(Buffer.from(compiled.result, 'base64')),
      sourceMap: new ProgramSourceMap(JSON.parse(algosdk.encodeJSON(compiled.sourcemap!))),
    }
    this._compilationResults[tealCode] = result

    return result
  }

  /**
   * Performs template substitution of a teal template and compiles it, returning the compiled result.
   *
   * Looks for `TMPL_{parameter}` for template replacements and replaces AlgoKit deploy-time control parameters
   * if deployment metadata is specified.
   *
   * * `TMPL_UPDATABLE` for updatability / immutability control
   * * `TMPL_DELETABLE` for deletability / permanence control
   *
   * @param tealTemplateCode The TEAL logic to compile
   * @param templateParams Any parameters to replace in the .teal file before compiling
   * @param deploymentMetadata The deployment metadata the app will be deployed with
   * @returns The information about the compiled code
   * @example
   * ```typescript
   * const compiled = await appManager.compileTealTemplate(tealTemplate, { TMPL_APP_ID: 12345n }, { updatable: true, deletable: false })
   * ```
   */
  async compileTealTemplate(
    tealTemplateCode: string,
    templateParams?: TealTemplateParams,
    deploymentMetadata?: { updatable?: boolean; deletable?: boolean },
  ): Promise<CompiledTeal> {
    let tealCode = AppManager.stripTealComments(tealTemplateCode)

    tealCode = AppManager.replaceTealTemplateParams(tealCode, templateParams)

    if (deploymentMetadata) {
      tealCode = AppManager.replaceTealTemplateDeployTimeControlParams(tealCode, deploymentMetadata)
    }

    return await this.compileTeal(tealCode)
  }

  /**
   * Returns a previous compilation result.
   * @param tealCode The TEAL code
   * @returns The information about the previously compiled file
   *  or `undefined` if that TEAL code wasn't previously compiled
   * @example
   * ```typescript
   * const compiled = appManager.getCompilationResult(tealProgram)
   * ```
   */
  getCompilationResult(tealCode: string): CompiledTeal | undefined {
    return this._compilationResults[tealCode]
  }

  /**
   * Returns the current app information for the app with the given ID.
   *
   * @example
   * ```typescript
   * const appInfo = await appManager.getById(12353n);
   * ```
   *
   * @param appId The ID of the app
   * @param options Optional `round` to read the app as of the end of a past round (needs dtalgod time travel)
   * @returns The app information
   */
  public async getById(appId: bigint, options?: AtRoundOptions): Promise<AppInformation> {
    const round = options?.round
    const app =
      round === undefined
        ? await this._algod.getApplicationByID(Number(appId)).do(undefined, fetchOptions(options))
        : await (
            await dtAlgodForRead(this._algod, 'Reading an app', round, true)
          )
            .getApplicationByID(appId)
            .round(round)
            .do(undefined, fetchOptions(options))
    return AppManager.appInformationFromAlgod(app)
  }

  /**
   * Converts an algod application into an `AppInformation`.
   * @param app The application from algod
   * @returns The app information
   */
  public static appInformationFromAlgod(app: modelsv2.Application): AppInformation {
    const params = app.params!
    return {
      appId: BigInt(app.id),
      appAddress: algosdk.getApplicationAddress(app.id),
      approvalProgram: params.approvalProgram,
      clearStateProgram: params.clearStateProgram,
      creator: params.creator,
      localInts: Number(params.localStateSchema?.numUint ?? 0),
      localByteSlices: Number(params.localStateSchema?.numByteSlice ?? 0),
      globalInts: Number(params.globalStateSchema?.numUint ?? 0),
      globalByteSlices: Number(params.globalStateSchema?.numByteSlice ?? 0),
      extraProgramPages: Number(params.extraProgramPages ?? 0),
      globalState: AppManager.decodeAppState(params.globalState ?? []),
      version: params.version,
    }
  }

  /**
   * Returns the current global state values for the given app ID and account address
   *
   * @param appId The ID of the app to return global state for
   * @param options Optional `round` to read the state as of the end of a past round (needs dtalgod time travel)
   * @returns The current global state for the given app
   * @example
   * ```typescript
   * const globalState = await appManager.getGlobalState(12353n);
   * ```
   */
  public async getGlobalState(appId: bigint, options?: AtRoundOptions) {
    return (await this.getById(appId, options)).globalState
  }

  /**
   * Returns the current local state values for the given app ID and account address
   *
   * @param appId The ID of the app to return local state for
   * @param address The string address of the account to get local state for the given app
   * @param options Optional `round` to read the state as of the end of a past round (needs dtalgod time travel)
   * @returns The current local state for the given (app, account) combination
   * @example
   * ```typescript
   * const localState = await appManager.getLocalState(12353n, 'ACCOUNTADDRESS');
   * ```
   */
  public async getLocalState(appId: bigint, address: Address | string, options?: AtRoundOptions) {
    const round = options?.round
    const appInfo =
      round === undefined
        ? await this._algod.accountApplicationInformation(address, appId).do(undefined, fetchOptions(options))
        : await (
            await dtAlgodForRead(this._algod, 'Reading local state', round, false)
          )
            .accountApplicationInformation(address, appId)
            .round(round)
            .do(undefined, fetchOptions(options))

    if (!appInfo.appLocalState?.keyValue) {
      throw new Error("Couldn't find local state")
    }

    return AppManager.decodeAppState(appInfo.appLocalState.keyValue)
  }

  /**
   * Returns the names of the current boxes for the given app.
   * @param appId The ID of the app return box names for
   * @param options Optional `round` to list the boxes as of the end of a past round (needs dtalgod time travel)
   * @returns The current box names
   * @example
   * ```typescript
   * const boxNames = await appManager.getBoxNames(12353n);
   * ```
   */
  public async getBoxNames(appId: bigint, options?: AtRoundOptions): Promise<BoxName[]> {
    const round = options?.round
    let boxes: modelsv2.BoxDescriptor[]
    if (round === undefined) {
      boxes = (await this._algod.getApplicationBoxes(appId).do(undefined, fetchOptions(options))).boxes
    } else {
      // Listing a past round can come in pages; the pages of one round fit together because past rounds never change
      const tt = await dtAlgodForRead(this._algod, 'Listing boxes', round, false)
      boxes = []
      let next: string | undefined = undefined
      do {
        const page: modelsv2.BoxesResponse = await tt
          .getApplicationBoxes(appId)
          .round(round)
          .next(next)
          .do(undefined, fetchOptions(options))
        boxes.push(...page.boxes)
        next = page.nextToken
      } while (next)
    }
    return boxes.map((b) => {
      return {
        nameRaw: b.name,
        nameBase64: Buffer.from(b.name).toString('base64'),
        name: Buffer.from(b.name).toString('utf-8'),
      }
    })
  }

  /**
   * Returns the boxes of an app, optionally only those whose names start with `prefix`, optionally with their values,
   * from the node's paged box listing: one request per page (up to the node's `MaxAPIBoxPerApplication` boxes or about
   * 1 MB of values) instead of a listing and one read per box.
   *
   * With `round`, every page is read at that round (needs dtalgod time travel), so the listing is one consistent
   * snapshot. Without it, later pages follow `next` at the latest round, as stock clients do, so a long listing can
   * straddle rounds.
   *
   * On a node or algosdk without the paged listing (algosdk before 3.6, or a node that answers without `round`), the
   * names are listed in one request, filtered by the prefix here, and the values read 8 boxes at a time.
   *
   * @param appId The ID of the app
   * @param options The name prefix (a string is UTF-8; empty means every box), whether to include values, the page size,
   *   a past `round` and an abort signal
   * @returns The boxes, in the order the node lists them (by name in the paged listing)
   * @example
   * ```typescript
   * const boxes = await algorand.app.getBoxes(appId, { prefix: 'u', includeValues: true })
   * ```
   */
  public async getBoxes(appId: bigint, options?: GetBoxesOptions): Promise<BoxWithValue[]> {
    const { prefix: prefixOption, includeValues = false, limit, round } = options ?? {}
    const prefix =
      typeof prefixOption === 'string' ? new Uint8Array(Buffer.from(prefixOption, 'utf-8')) : (prefixOption ?? new Uint8Array())
    const tt = round === undefined ? undefined : await dtAlgodForRead(this._algod, 'Listing boxes', round, false)
    const listing = (): PagedBoxesRequest =>
      (tt ? tt.getApplicationBoxes(appId).round(round!) : this._algod.getApplicationBoxes(appId)) as unknown as PagedBoxesRequest
    const toBoxName = (name: Uint8Array): BoxName => ({
      nameRaw: name,
      nameBase64: Buffer.from(name).toString('base64'),
      name: Buffer.from(name).toString('utf-8'),
    })

    const boxes: BoxWithValue[] = []
    let request = listing()
    if (typeof request.prefix === 'function' && typeof request.include === 'function') {
      let next: string | undefined = undefined
      for (;;) {
        if (prefix.length > 0) request.prefix!(prefix)
        if (includeValues) request.include!('values')
        if (limit !== undefined) request.limit(limit)
        if (next !== undefined) request.next(next)
        const page: PagedBoxesResponse = await request.do(undefined, fetchOptions(options))
        // A paged answer has its round; a node that ignored the paging parameters lists every name, without values
        if (page.round === undefined) return await this.filteredBoxes(appId, page.boxes, prefix, includeValues, options)
        for (const b of page.boxes)
          boxes.push({ name: toBoxName(b.name), ...(includeValues ? { value: b.value ?? new Uint8Array() } : {}) })
        next = page.nextToken || undefined
        if (!next) return boxes
        request = listing()
      }
    }
    const names = round === undefined ? undefined : await this.getBoxNames(appId, options)
    return await this.filteredBoxes(
      appId,
      names?.map((n) => ({ name: n.nameRaw })) ?? (await request.do(undefined, fetchOptions(options))).boxes,
      prefix,
      includeValues,
      options,
    )
  }

  /** The boxes of a listing without paging: the names under `prefix`, with their values read 8 at a time. */
  private async filteredBoxes(
    appId: bigint,
    listed: { name: Uint8Array }[],
    prefix: Uint8Array,
    includeValues: boolean,
    options: AtRoundOptions | undefined,
  ): Promise<BoxWithValue[]> {
    const names = listed
      .filter((b) => b.name.length >= prefix.length && prefix.every((x, i) => b.name[i] === x))
      .map((b) => ({ nameRaw: b.name, nameBase64: Buffer.from(b.name).toString('base64'), name: Buffer.from(b.name).toString('utf-8') }))
    if (!includeValues) return names.map((name) => ({ name }))
    return await mapConcurrently(names, 8, async (name) => ({ name, value: await this.getBoxValue(appId, name, options) }))
  }

  /**
   * Returns the value of the given box name for the given app.
   * @param appId The ID of the app return box names for
   * @param boxName The name of the box to return either as a string, binary array or `BoxName`
   * @param options Optional `round` to read the box as of the end of a past round (needs dtalgod time travel)
   * @returns The current box value as a byte array
   * @example
   * ```typescript
   * const boxValue = await appManager.getBoxValue(12353n, 'boxName');
   * ```
   */
  public async getBoxValue(appId: bigint, boxName: BoxIdentifier | BoxName, options?: AtRoundOptions): Promise<Uint8Array> {
    const boxId = typeof boxName === 'object' && 'nameRaw' in boxName ? boxName.nameRaw : boxName
    const name = AppManager.getBoxReference(boxId).name
    const round = options?.round
    const boxResult =
      round === undefined
        ? await this._algod.getApplicationBoxByName(Number(appId), name).do(undefined, fetchOptions(options))
        : await (
            await dtAlgodForRead(this._algod, 'Reading a box', round, false)
          )
            .getApplicationBoxByName(appId, name)
            .round(round)
            .do(undefined, fetchOptions(options))
    return boxResult.value
  }

  /**
   * Returns the value of the given box names for the given app.
   * @param appId The ID of the app return box names for
   * @param boxNames The names of the boxes to return either as a string, binary array or `BoxName`
   * @param options Optional `round` to read the boxes as of the end of a past round (needs dtalgod time travel)
   * @returns The current box values as a byte array in the same order as the passed in box names
   * @example
   * ```typescript
   * const boxValues = await appManager.getBoxValues(12353n, ['boxName1', 'boxName2']);
   * ```
   */
  public async getBoxValues(appId: bigint, boxNames: (BoxIdentifier | BoxName)[], options?: AtRoundOptions): Promise<Uint8Array[]> {
    return await Promise.all(boxNames.map(async (boxName) => await this.getBoxValue(appId, boxName, options)))
  }

  /**
   * Returns the value of the given box name for the given app decoded based on the given ABI type.
   * @param request The parameters for the box value request
   * @returns The current box value as an ABI value
   * @example
   * ```typescript
   * const boxValue = await appManager.getBoxValueFromABIType({ appId: 12353n, boxName: 'boxName', type: new ABIUintType(32) });
   * ```
   */
  public async getBoxValueFromABIType(request: BoxValueRequestParams): Promise<algosdk.ABIValue> {
    const { appId, boxName, type, round } = request
    const value = await this.getBoxValue(appId, boxName, round === undefined ? undefined : { round })
    return type.decode(value)
  }

  /**
   * Returns the value of the given box names for the given app decoded based on the given ABI type.
   * @param request The parameters for the box value request
   * @returns The current box values as an ABI value in the same order as the passed in box names
   * @example
   * ```typescript
   * const boxValues = await appManager.getBoxValuesFromABIType({ appId: 12353n, boxNames: ['boxName1', 'boxName2'], type: new ABIUintType(32) });
   * ```
   */
  public async getBoxValuesFromABIType(request: BoxValuesRequestParams): Promise<algosdk.ABIValue[]> {
    const { appId, boxNames, type, round } = request
    return await Promise.all(boxNames.map(async (boxName) => await this.getBoxValueFromABIType({ appId, boxName, type, round })))
  }

  /**
   * Returns a `algosdk.BoxReference` given a `BoxIdentifier` or `BoxReference`.
   * @param boxId The box to return a reference for
   * @returns The box reference ready to pass into a `algosdk.Transaction`
   * @example
   * ```typescript
   * const boxRef = AppManager.getBoxReference('boxName');
   * ```
   */
  public static getBoxReference(boxId: BoxIdentifier | BoxReference): algosdk.BoxReference {
    const ref = typeof boxId === 'object' && 'appId' in boxId ? boxId : { appId: 0n, name: boxId }
    return {
      appIndex: ref.appId,
      name: typeof ref.name === 'string' ? new TextEncoder().encode(ref.name) : 'length' in ref.name ? ref.name : ref.name.addr.publicKey,
    } as algosdk.BoxReference
  }

  /**
   * Converts an array of global/local state values from the algod api to a more friendly
   * generic object keyed by the UTF-8 value of the key.
   * @param state A `global-state`, `local-state`, `global-state-deltas` or `local-state-deltas`
   * @returns An object keyeed by the UTF-8 representation of the key with various parsings of the values
   * @example
   * ```typescript
   * const stateValues = AppManager.decodeAppState(state);
   * ```
   */
  public static decodeAppState(state: { key: Uint8Array; value: modelsv2.TealValue | modelsv2.EvalDelta }[]): AppState {
    const stateValues = {} as AppState

    // Start with empty set
    for (const stateVal of state) {
      const keyBase64 = Buffer.from(stateVal.key).toString('base64')
      const keyRaw = stateVal.key
      const key = Buffer.from(stateVal.key).toString('utf-8')
      const tealValue = stateVal.value

      const dataTypeFlag = 'action' in tealValue ? tealValue.action : tealValue.type
      let valueBase64: string
      let valueRaw: Buffer
      switch (dataTypeFlag) {
        case 1:
          valueBase64 =
            typeof tealValue.bytes === 'string' ? tealValue.bytes : tealValue.bytes ? Buffer.from(tealValue.bytes).toString('base64') : ''
          valueRaw = Buffer.from(valueBase64, 'base64')
          stateValues[key] = {
            keyRaw,
            keyBase64,
            valueRaw: new Uint8Array(valueRaw),
            valueBase64: valueBase64,
            value: valueRaw.toString('utf-8'),
          }
          break
        case 2: {
          const value = tealValue.uint ?? 0
          stateValues[key] = {
            keyRaw,
            keyBase64,
            value: BigInt(value),
          }
          break
        }
        default:
          throw new Error(`Received unknown state data type of ${dataTypeFlag}`)
      }
    }

    return stateValues
  }

  /**
   * Returns any ABI return values for the given app call arguments and transaction confirmation.
   * @param confirmation The transaction confirmation from algod
   * @param method The ABI method
   * @returns The return value for the method call
   * @example
   * ```typescript
   * const returnValue = AppManager.getABIReturn(confirmation, ABIMethod.fromSignature('hello(string)void'));
   * ```
   */
  public static getABIReturn(
    confirmation: modelsv2.PendingTransactionResponse | undefined,
    method: algosdk.ABIMethod | undefined,
  ): ABIReturn | undefined {
    if (!method || !confirmation || method.returns.type === 'void') {
      return undefined
    }

    // The parseMethodResponse method mutates the second parameter :(
    const resultDummy: algosdk.ABIResult = {
      txID: '',
      method,
      rawReturnValue: new Uint8Array(),
    }
    return getABIReturnValue(algosdk.AtomicTransactionComposer.parseMethodResponse(method, resultDummy, confirmation), method.returns.type)
  }

  /**
   * Replaces AlgoKit deploy-time deployment control parameters within the given TEAL template code.
   *
   * * `TMPL_UPDATABLE` for updatability / immutability control
   * * `TMPL_DELETABLE` for deletability / permanence control
   *
   * Note: If these values are defined, but the corresponding `TMPL_*` value
   *  isn't in the teal code it will throw an exception.
   *
   * @param tealTemplateCode The TEAL template code to substitute
   * @param params The deploy-time deployment control parameter value to replace
   * @returns The replaced TEAL code
   * @example
   * ```typescript
   * const tealCode = AppManager.replaceTealTemplateDeployTimeControlParams(tealTemplate, { updatable: true, deletable: false });
   * ```
   */
  static replaceTealTemplateDeployTimeControlParams(tealTemplateCode: string, params: { updatable?: boolean; deletable?: boolean }) {
    if (params.updatable !== undefined) {
      if (!tealTemplateCode.includes(UPDATABLE_TEMPLATE_NAME)) {
        throw new Error(
          `Deploy-time updatability control requested for app deployment, but ${UPDATABLE_TEMPLATE_NAME} not present in TEAL code`,
        )
      }
      tealTemplateCode = replaceTemplateVariable(tealTemplateCode, UPDATABLE_TEMPLATE_NAME, (params.updatable ? 1 : 0).toString())
    }

    if (params.deletable !== undefined) {
      if (!tealTemplateCode.includes(DELETABLE_TEMPLATE_NAME)) {
        throw new Error(
          `Deploy-time deletability control requested for app deployment, but ${DELETABLE_TEMPLATE_NAME} not present in TEAL code`,
        )
      }
      tealTemplateCode = replaceTemplateVariable(tealTemplateCode, DELETABLE_TEMPLATE_NAME, (params.deletable ? 1 : 0).toString())
    }

    return tealTemplateCode
  }

  /**
   * Performs template substitution of a teal file.
   *
   * Looks for `TMPL_{parameter}` for template replacements.
   *
   * @param tealTemplateCode The TEAL template code to make parameter replacements in
   * @param templateParams Any parameters to replace in the teal code
   * @returns The TEAL code with replacements
   * @example
   * ```typescript
   * const tealCode = AppManager.replaceTealTemplateParams(tealTemplate, { TMPL_APP_ID: 12345n });
   * ```
   */
  static replaceTealTemplateParams(tealTemplateCode: string, templateParams?: TealTemplateParams) {
    if (templateParams !== undefined) {
      for (const key in templateParams) {
        const value = templateParams[key]
        const token = `TMPL_${key.replace(/^TMPL_/, '')}`

        // If this is a number, first replace any byte representations of the number
        // These may appear in the TEAL in order to circumvent int compression and preserve PC values
        if (typeof value === 'number' || typeof value === 'bigint') {
          tealTemplateCode = tealTemplateCode.replace(new RegExp(`(?<=bytes )${token}`, 'g'), `0x${value.toString(16).padStart(16, '0')}`)

          // We could probably return here since mixing pushint and pushbytes is likely not going to happen, but might as well do both
        }

        tealTemplateCode = replaceTemplateVariable(
          tealTemplateCode,
          token,
          typeof value === 'string'
            ? `0x${Buffer.from(value, 'utf-8').toString('hex')}`
            : ArrayBuffer.isView(value)
              ? `0x${Buffer.from(value).toString('hex')}`
              : value.toString(),
        )
      }
    }

    return tealTemplateCode
  }

  /**
   * Remove comments from TEAL code (useful to reduce code size before compilation).
   *
   * @param tealCode The TEAL logic to strip
   * @returns The TEAL without comments
   * @example
   * ```typescript
   * const stripped = AppManager.stripTealComments(tealProgram);
   * ```
   */
  static stripTealComments(tealCode: string) {
    const stripCommentFromLine = (line: string) => {
      const commentIndex = findUnquotedString(line, '//')
      if (commentIndex === undefined) {
        return line
      }
      return line.slice(0, commentIndex).trimEnd()
    }

    return tealCode
      .split('\n')
      .map((line) => stripCommentFromLine(line))
      .join('\n')
  }
}

/**
 * Find the first string within a line of TEAL. Only matches outside of quotes and base64 are returned.
 * Returns undefined if not found
 */
const findUnquotedString = (line: string, token: string, startIndex: number = 0, _endIndex?: number): number | undefined => {
  const endIndex = _endIndex === undefined ? line.length : _endIndex
  let index = startIndex
  let inQuotes = false
  let inBase64 = false

  while (index < endIndex) {
    const currentChar = line[index]
    if ((currentChar === ' ' || currentChar === '(') && !inQuotes && lastTokenBase64(line, index)) {
      // enter base64
      inBase64 = true
    } else if ((currentChar === ' ' || currentChar === ')') && !inQuotes && inBase64) {
      // exit base64
      inBase64 = false
    } else if (currentChar === '\\' && inQuotes) {
      // escaped char, skip next character
      index += 1
    } else if (currentChar === '"') {
      // quote boundary
      inQuotes = !inQuotes
    } else if (!inQuotes && !inBase64 && line.startsWith(token, index)) {
      // can test for match
      return index
    }
    index += 1
  }
  return undefined
}

const lastTokenBase64 = (line: string, index: number): boolean => {
  try {
    const tokens = line.slice(0, index).split(/\s+/)
    const last = tokens[tokens.length - 1]
    return ['base64', 'b64'].includes(last)
  } catch {
    return false
  }
}

function replaceTemplateVariable(program: string, token: string, replacement: string): string {
  const result: string[] = []
  const tokenIndexOffset = replacement.length - token.length

  const programLines = program.split('\n')

  for (const line of programLines) {
    const _commentIndex = findUnquotedString(line, '//')
    const commentIndex = _commentIndex === undefined ? line.length : _commentIndex
    let code = line.substring(0, commentIndex)
    const comment = line.substring(commentIndex)
    let trailingIndex = 0

    while (true) {
      const tokenIndex = findTemplateToken(code, token, trailingIndex)
      if (tokenIndex === undefined) {
        break
      }
      trailingIndex = tokenIndex + token.length
      const prefix = code.substring(0, tokenIndex)
      const suffix = code.substring(trailingIndex)
      code = `${prefix}${replacement}${suffix}`
      trailingIndex += tokenIndexOffset
    }
    result.push(code + comment)
  }

  return result.join('\n')
}

const findTemplateToken = (line: string, token: string, startIndex: number = 0, _endIndex?: number): number | undefined => {
  const endIndex = _endIndex === undefined ? line.length : _endIndex

  let index = startIndex
  while (index < endIndex) {
    const tokenIndex = findUnquotedString(line, token, index, endIndex)
    if (tokenIndex === undefined) {
      break
    }
    const trailingIndex = tokenIndex + token.length
    if (
      (tokenIndex === 0 || !isValidTokenCharacter(line[tokenIndex - 1])) &&
      (trailingIndex >= line.length || !isValidTokenCharacter(line[trailingIndex]))
    ) {
      return tokenIndex
    }
    index = trailingIndex
  }
  return undefined
}

function isValidTokenCharacter(char: string): boolean {
  return char.length === 1 && (/\w/.test(char) || char === '_')
}
