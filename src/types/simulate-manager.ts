import algosdk from 'algosdk'
import { getABIReturnValue } from '../transaction/transaction'
import { ClientManager } from './client-manager'
import { BuiltTransactions, RawSimulateOptions, TransactionComposer } from './composer'
import {
  asSentGroup,
  DTSimulateResponseLike,
  RawSimulateGroupOutcome,
  Capabilities,
  Round,
  SimulateLimits,
  concurrencyLimiter,
  getCapabilities,
  requireDTNode,
  requireDTSdk,
  txIdsOf,
} from './dt-support'
import { SendAtomicTransactionComposerResults } from './transaction'
import modelsv2 = algosdk.modelsv2

/** The most simulate requests in flight at once, by default. */
export const DEFAULT_SIMULATE_CONCURRENCY = 4

/** Options for an extended simulate request. */
export type ExtendedSimulateOptions = Omit<RawSimulateOptions, 'allowEmptySignatures' | 'fixSigners' | 'round'> & {
  /**
   * Simulate each group on its own against the starting state, in a request of its own, instead of one after the other in
   * one block. Parallel groups don't see each other's effects. When the groups go in several requests at the latest
   * round, it is looked up first so they all run at the same round.
   */
  parallel?: boolean
  /**
   * The most groups per request without `parallel`. Groups one after the other can't be split across requests, so more
   * than this throws. Defaults to the node's `maxTxnGroups` (see `limits()`). Above what the node allows, the node rejects
   * the request.
   */
  maxGroups?: number
  /**
   * The most simulate requests in flight at once (default {@link DEFAULT_SIMULATE_CONCURRENCY}, 4), across the rounds of
   * `rounds` and the requests of `parallel` groups. After a request fails, the ones not yet sent aren't.
   */
  concurrency?: number
}

/** Options to simulate several groups at one round. */
export type SimulateGroupsOptions = ExtendedSimulateOptions & {
  /**
   * Simulate as of the end of this past round (0 or `undefined` for the latest round). Needs time travel on the node
   * for rounds older than its `MaxAcctLookback`. Transactions that don't set their own validity are built valid at this
   * round.
   */
  round?: Round
}

/** Options to simulate groups at several rounds. */
export type SimulateRoundsOptions = ExtendedSimulateOptions

/** The result of a group that simulated without failing. */
export type SimulateGroupResult = SendAtomicTransactionComposerResults & {
  /** The whole simulate response the group came in. */
  simulateResponse: modelsv2.SimulateResponse
}

/** Why a group has no result: the group failed, the group wasn't simulated, or the node returned no result for it. */
export type SimulateGroupError = Error & {
  /**
   * - `group`: the group failed (see `failureMessage` and `failedAt`)
   * - `not-simulated`: the group wasn't simulated because an earlier group broke the block
   * - `missing`: the node returned no result for the group
   */
  kind: 'group' | 'not-simulated' | 'missing'
  /** The failure message of a failed group. */
  failureMessage?: string
  /** The path of the failed transaction of a failed group. */
  failedAt?: number[]
  /** The result of a failed group, with the results of its transactions up to the failure. */
  result?: modelsv2.SimulateTransactionGroupResult
}

/** The outcome of one group of an extended simulate request. */
export type SimulateGroupOutcome = {
  /** The index of the group, in the order the composers were given. */
  groupIndex: number
  /** The round the group was simulated at: the state as of the end of this round. */
  round: bigint
} & ({ ok: true; result: SimulateGroupResult } | { ok: false; error: SimulateGroupError })

/** The outcomes of the groups at one round. */
export interface SimulateRoundOutcome {
  /** The round, as given. */
  round: bigint
  /** The outcome of each group, in the order the composers were given. */
  groups: SimulateGroupOutcome[]
}

/** The options dtalgod's simulate no longer takes (dt5), with where they went. */
const REMOVED_OPTIONS: Record<string, string> = {
  protocol: 'use algorand.query (query.run, or query.groups / query.rounds) to run past rounds under another protocol',
  validityWindow: 'simulate.rounds builds the groups valid at each round, one request per round',
  maxRounds: 'simulate.rounds sends one request per round',
}

/** Throws for an option dtalgod's simulate no longer takes, which a caller from before dt5 may still pass. */
function checkRemovedOptions(options: object): void {
  for (const [name, instead] of Object.entries(REMOVED_OPTIONS)) {
    if ((options as Record<string, unknown>)[name] !== undefined) throw new Error(`simulate no longer takes ${name}: ${instead}`)
  }
}

/** The validity window of transactions simulated at `round` (none for the latest round). */
const validityAt = (round: Round | undefined) =>
  round ? { firstValidRound: BigInt(round) + 1n, lastValidRound: BigInt(round) + 11n } : undefined

/**
 * Checks extended simulate options against the capabilities the node reported, throwing for what it doesn't allow.
 * Shared with `QueryManager`, which validates the same options (and its `protocol`).
 */
export function checkSimulateLimits(
  capabilities: Capabilities,
  protocol: string | undefined,
  raw: Pick<RawSimulateOptions, 'execTraceConfig' | 'extraOpcodeBudget'>,
): void {
  if (!capabilities.developerApi) {
    if (protocol === 'future') {
      throw new Error("protocol 'future' needs a node with the developer API (EnableDeveloperAPI), and this node has it off")
    }
    if (raw.execTraceConfig?.enable) {
      throw new Error('execTraceConfig needs a node with the developer API (EnableDeveloperAPI), and this node has it off')
    }
  }
  const { extraOpcodeBudget } = raw
  const { maxExtraOpcodeBudget } = capabilities.simulate
  if (extraOpcodeBudget !== undefined && BigInt(extraOpcodeBudget) > BigInt(maxExtraOpcodeBudget)) {
    throw new Error(`extraOpcodeBudget ${extraOpcodeBudget} is more than the node allows (maxExtraOpcodeBudget ${maxExtraOpcodeBudget})`)
  }
}

/** The `concurrency` option, checked: a positive integer, or the default. */
function checkConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return DEFAULT_SIMULATE_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency must be a positive integer, not ${concurrency}`)
  return concurrency
}

/** Turns a successful group result into the same shape as `TransactionComposer.simulate` returns. */
function toGroupResult(
  built: BuiltTransactions,
  group: modelsv2.SimulateTransactionGroupResult,
  simulateResponse: modelsv2.SimulateResponse,
): SimulateGroupResult {
  const { transactions, methodCalls } = built
  const { groupId, txIds } = txIdsOf(built)
  const confirmations = group.txnResults.map((t) => t.txnResult)
  const returns = [...methodCalls.entries()].map(([index, method]) =>
    getABIReturnValue(
      algosdk.AtomicTransactionComposer.parseMethodResponse(
        method,
        { txID: txIds[index], rawReturnValue: new Uint8Array(), method },
        confirmations[index],
      ),
      method.returns.type,
    ),
  )
  return {
    confirmations,
    transactions,
    txIds: [...txIds],
    groupId,
    simulateResponse,
    returns,
  }
}

function toOutcome(
  raw: RawSimulateGroupOutcome,
  groupIndex: number,
  built: BuiltTransactions,
  response: modelsv2.SimulateResponse,
): SimulateGroupOutcome {
  const base = { groupIndex, round: raw.round }
  return raw.ok ? { ...base, ok: true, result: toGroupResult(built, raw.result, response) } : { ...base, ok: false, error: raw.error }
}

/**
 * Extended simulate on dtalgod: several transaction groups in one request (one after the other in one block), groups in
 * parallel (each alone, in a request of its own), and the same groups at several rounds (a request per round).
 *
 * The groups are simulated without signatures (like `simulate({ skipSignatures: true })`), so this is for reads and
 * dry runs. Needs dt-algosdk (without it, every method throws a `DTNotAvailableError`) and dtalgod: on stock algod,
 * `groups` and `rounds` throw dt-algosdk's `DTUnsupportedError` before sending anything. The node's capabilities
 * (`algorand.client.capabilities()`), which tell the two apart, are asked for once per algod client.
 *
 * For read-only app calls, `algorand.query` is faster: many calls at many rounds per request, under another protocol if
 * asked.
 */
export class SimulateManager {
  private _clientManager: ClientManager

  /**
   * Create a new simulate manager.
   * @param clientManager The `ClientManager` client to use for algod
   */
  constructor(clientManager: ClientManager) {
    this._clientManager = clientManager
  }

  /**
   * Simulates several transaction groups at the latest round or at a past `round`.
   *
   * The node's limits (see `limits()`) apply: at most `maxTxnGroups` groups per request, and an `extraOpcodeBudget` above
   * `maxExtraOpcodeBudget` throws.
   *
   * By default the groups run one after the other in one block, in one request: later groups see the effects of earlier
   * ones, and a failed group is rolled back without stopping the later ones. With `parallel`, each group runs on its own
   * against the starting state, in a request of its own.
   *
   * @param composers The groups, one composer each
   * @param options The simulate options
   * @returns The outcome of each group, in order
   * @example
   * ```typescript
   * const [a, b] = await algorand.simulate.groups([algorand.newGroup().addPayment(...), algorand.newGroup().addAppCallMethodCall(...)], {
   *   allowUnnamedResources: true,
   * })
   * if (b.ok) console.log(b.result.returns?.[0]?.returnValue)
   * ```
   */
  public async groups(composers: TransactionComposer[], options?: SimulateGroupsOptions): Promise<SimulateGroupOutcome[]> {
    const { round, ...rest } = options ?? {}
    requireDTSdk('Simulating several groups')
    checkRemovedOptions(rest)
    rest.signal?.throwIfAborted()
    // The capabilities are cached per client and shared, so they are read without the signal
    const capabilities = await requireDTNode(this._clientManager.algod, 'Simulating several groups')
    const limit = concurrencyLimiter(checkConcurrency(rest.concurrency))
    const built = await this.buildGroups(composers, validityAt(round))
    return await this.send(built, rest, round, capabilities, limit)
  }

  /**
   * Returns the node's simulate limits: how many groups a request may hold, and the most `extraOpcodeBudget`. `groups`
   * and `rounds` keep to them.
   *
   * They are the `simulate` part of the node's capabilities (`algorand.client.capabilities()`, which also says whether the
   * node is dtalgod at all, and which features it has on), asked for once per algod client. Stock algod, which has no
   * capabilities endpoint, gets stock algod's limits.
   *
   * @returns The node's simulate limits
   * @throws DTNotAvailableError if the loaded algosdk is not dt-algosdk
   * @example
   * ```typescript
   * const { maxTxnGroups, maxExtraOpcodeBudget } = await algorand.simulate.limits()
   * ```
   */
  public async limits(): Promise<SimulateLimits> {
    requireDTSdk('Reading the simulate limits')
    return (await getCapabilities(this._clientManager.algod))!.simulate
  }

  /**
   * Simulates the same transaction groups at several past rounds: a request per round (and per group with `parallel`),
   * `concurrency` at a time. The groups are built again for each round, valid at it; transactions that set their own
   * `firstValidRound` / `lastValidRound` keep them. A duplicate round is simulated once. A round the node can't simulate
   * (one it doesn't have) throws.
   *
   * For read-only app calls, `algorand.query.rounds` takes many rounds per request.
   *
   * @param composers The groups, one composer each (or a single composer)
   * @param rounds The rounds to simulate at (each > 0): the state as of the end of each round
   * @param options The simulate options
   * @returns The outcomes at each round, in the order of `rounds`
   * @example
   * ```typescript
   * const composer = algorand.newGroup().addAppCallMethodCall(await appClient.params.call({ method: 'get_price' }))
   * const prices = await algorand.simulate.rounds(composer, [45_000_000n, 45_001_000n, 45_002_000n], { allowUnnamedResources: true })
   * for (const { round, groups: [g] } of prices) if (g.ok) console.log(round, g.result.returns?.[0]?.returnValue)
   * ```
   */
  public async rounds(
    composers: TransactionComposer | TransactionComposer[],
    rounds: Round[],
    options?: SimulateRoundsOptions,
  ): Promise<SimulateRoundOutcome[]> {
    const groups = Array.isArray(composers) ? composers : [composers]
    requireDTSdk('Simulating at several rounds')
    checkRemovedOptions(options ?? {})
    const limit = concurrencyLimiter(checkConcurrency(options?.concurrency))
    options?.signal?.throwIfAborted()
    // The capabilities are cached per client and shared, so they are read without the signal
    const capabilities = await requireDTNode(this._clientManager.algod, 'Simulating at several rounds')
    // Checked like any other call first, so an empty list doesn't hide a missing dt-algosdk or dtalgod
    if (rounds.length === 0) return []
    const unique = [...new Set(rounds.map((r) => BigInt(r)))]
    const zero = unique.find((r) => r < 1n)
    if (zero !== undefined) {
      throw new RangeError(`Can't simulate at round ${zero} in rounds: give past rounds (look the latest round up with status())`)
    }
    // Build every round, then send `concurrency` at a time
    const built: BuiltTransactions[][] = []
    for (const r of unique) built.push(await this.buildGroups(groups, validityAt(r)))
    const results = await Promise.all(unique.map((r, i) => this.send(built[i], options ?? {}, r, capabilities, limit)))
    const byRound = new Map(unique.map((r, i) => [r, results[i]]))
    return rounds.map((r) => ({ round: BigInt(r), groups: byRound.get(BigInt(r))! }))
  }

  private async buildGroups(
    composers: TransactionComposer[],
    validity: { firstValidRound: bigint; lastValidRound: bigint } | undefined,
  ): Promise<BuiltTransactions[]> {
    if (composers.length === 0) throw new Error('No transaction groups to simulate')
    const built: BuiltTransactions[] = []
    for (const composer of composers) {
      const b = validity ? await composer.buildTransactionsWithValidity(validity) : await composer.buildTransactions()
      if (b.transactions.length === 0) throw new Error(`Transaction group ${built.length} is empty`)
      built.push(asSentGroup(b))
    }
    return built
  }

  /** Sends the groups at one round (the latest for none): in one request, or one request per group with `parallel`. */
  private async send(
    built: BuiltTransactions[],
    options: ExtendedSimulateOptions,
    round: Round | undefined,
    capabilities: Capabilities,
    limit: ReturnType<typeof concurrencyLimiter>,
  ): Promise<SimulateGroupOutcome[]> {
    const tt = requireDTSdk('Simulating several groups')
    const { parallel = false, maxGroups: maxGroupsOption, signal, concurrency: _concurrency, ...raw } = options
    signal?.throwIfAborted()
    // Fetch options for each request: the signal goes to fetch, never into the request body
    const fetchOptions = signal ? { signal } : undefined
    const maxGroups = maxGroupsOption ?? capabilities.simulate.maxTxnGroups
    if (!Number.isInteger(maxGroups) || maxGroups < 1) throw new RangeError(`maxGroups must be a positive integer, not ${maxGroups}`)
    if (!parallel && built.length > maxGroups) {
      throw new Error(
        `Can't simulate ${built.length} groups one after the other: ${maxGroupsOption === undefined ? 'the node takes' : 'maxGroups allows'} at most ${maxGroups} per request (use parallel to send each group on its own)`,
      )
    }
    checkSimulateLimits(capabilities, undefined, raw)
    const requests = parallel ? built.map((g) => [g]) : [built]
    const algod = this._clientManager.dtAlgod
    // Parallel groups in several requests must all run at the same round, even if a new block comes in between
    let at = round || undefined
    if (requests.length > 1 && !at) at = (await this._clientManager.algod.status().do(undefined, fetchOptions)).lastRound

    const responses = await Promise.all(
      requests.map(async (groups) => {
        const request = tt.dtModels.DTSimulateRequest.fromTransactions(
          groups.map((g) => g.transactions),
          { ...raw, allowEmptySignatures: true, fixSigners: true, round: at },
        )
        return await limit(() => algod.simulateTransactions(request).do(undefined, fetchOptions))
      }),
    )

    return requests.flatMap((groups, r) => {
      const response: DTSimulateResponseLike = responses[r]
      return response.groupResults(groups.length).map((raw, g) => toOutcome(raw, parallel ? r : g, groups[g], response))
    })
  }
}
