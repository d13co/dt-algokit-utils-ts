import algosdk from 'algosdk'
import { getABIReturnValue } from '../transaction/transaction'
import { ClientManager } from './client-manager'
import { BuiltTransactions, RawSimulateOptions, TransactionComposer } from './composer'
import {
  DTSimulateResponseLike,
  RawSimulateGroupOutcome,
  Capabilities,
  Round,
  SimulateLimits,
  SimulateProtocolOverride,
  chunk,
  concurrencyLimiter,
  getCapabilities,
  mergeProtocolOverrides,
  offsetProtocolOverride,
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
   * Simulate each group on its own against the starting state, concurrently, instead of one after the other in one
   * block. Parallel groups don't see each other's effects.
   */
  parallel?: boolean
  /**
   * The most groups per request. Parallel groups beyond it are split across requests; sequential groups can't be split,
   * so more than this throws. Defaults to the node's `maxTxnGroups` (see `limits()`). Set it lower for smaller requests;
   * above what the node allows, the node rejects the request.
   */
  maxGroups?: number
  /**
   * The most simulate requests in flight at once (default {@link DEFAULT_SIMULATE_CONCURRENCY}, 4), across the windows of
   * `rounds` and the requests parallel groups are split into. After a request fails, the ones not yet sent aren't.
   */
  concurrency?: number
  /**
   * Simulate under a later consensus protocol, as if an upgrade to it took effect right after the round simulated at:
   * its programs, limits, fees and other parameters apply, to programs deployed earlier too. A consensus version string,
   * `v24` to `v43` for a mainline one, `latest` (the protocol of the block after the node's latest one) or `future`
   * (vFuture, only on a node with `EnableDeveloperAPI`). It must be a later protocol of the chain than the one the round
   * really ran; the protocol the round really ran is simulated as it is.
   *
   * Each outcome's `protocolOverride` says how it applied. An unknown name, or `future` without the developer API, fails
   * the whole request. A protocol that isn't a later one of the chain fails the request with `simulate.groups`, or that
   * round (`kind: 'round'`) with `simulate.rounds`.
   */
  protocol?: string
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
export type SimulateRoundsOptions = ExtendedSimulateOptions & {
  /**
   * The most rounds per request. More rounds are split across requests. Defaults to the node's `maxRounds` (see
   * `limits()`). 0, which a node with `rounds` disabled (`MaxAPISimulateRounds` 0) reports, sends one request per round
   * instead, with `round` set and without `rounds`: a round the node can't simulate then throws instead of failing only
   * its outcomes. Above what the node allows, the node rejects the request.
   */
  maxRounds?: number
  /**
   * Lets the rounds of one request be more than 1,000 rounds (`MaxTxnLife`) apart, so they are packed by `maxRounds` only:
   * - `rewrite`: at every round, each transaction's validity window is moved to the simulated block, keeping its width,
   *   and group IDs are recomputed. Transaction IDs change, so the results' `txIds` and `transactions` are those as
   *   built, not as simulated (the confirmations echo the rewritten ones). Transactions that differ only by their
   *   validity window become identical, so the later one fails as a duplicate: give them distinct notes.
   * - `skip`: the transactions are evaluated as built at every round, even outside their validity window. Leases,
   *   duplicates and fees are still checked. Programs see the window as built, so `block`, `FirstValidTime` and inner
   *   transactions stay tied to it.
   *
   * Not sent when `maxRounds` is 0: each round's request then has transactions built valid at it.
   */
  validityWindow?: 'skip' | 'rewrite'
}

/** The result of a group that simulated without failing. */
export type SimulateGroupResult = SendAtomicTransactionComposerResults & {
  /** The whole simulate response the group came in. */
  simulateResponse: modelsv2.SimulateResponse
}

/** Why a group has no result: the round failed, the group failed, the group wasn't simulated, or the node returned no result for it. */
export type SimulateGroupError = Error & {
  /**
   * - `round`: the whole round failed (for example a round the node doesn't have)
   * - `group`: the group failed (see `failureMessage` and `failedAt`)
   * - `not-simulated`: the group wasn't simulated because an earlier group broke the block
   * - `missing`: the node returned no result for the group
   */
  kind: 'round' | 'group' | 'not-simulated' | 'missing'
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
  /**
   * With `protocol`: how it applied at this round, the same for every group of the round. The notes' `hits` give the
   * `group` as an index in the order the composers were given. Undefined when the round failed.
   */
  protocolOverride?: SimulateProtocolOverride
} & ({ ok: true; result: SimulateGroupResult } | { ok: false; error: SimulateGroupError })

/** The outcomes of the groups at one round. */
export interface SimulateRoundOutcome {
  /** The round, as given. */
  round: bigint
  /** The outcome of each group, in the order the composers were given. */
  groups: SimulateGroupOutcome[]
  /**
   * With `protocol`: how it applied at this round (see `SimulateGroupOutcome.protocolOverride`). When parallel groups
   * were split across requests, the notes of all of them, and set if the round failed in some of them only.
   */
  protocolOverride?: SimulateProtocolOverride
}

/** Throws for a `validityWindow` other than `skip` or `rewrite`. Shared with `QueryManager`, which validates the same options. */
export const checkValidityWindow = ({ validityWindow }: { validityWindow?: string }): void => {
  if (validityWindow !== undefined && validityWindow !== 'skip' && validityWindow !== 'rewrite') {
    throw new Error(`validityWindow must be 'skip' or 'rewrite', not ${JSON.stringify(validityWindow)}`)
  }
}

/** The validity window of transactions simulated at `round` (none for the latest round). */
const validityAt = (round: Round | undefined) =>
  round ? { firstValidRound: BigInt(round) + 1n, lastValidRound: BigInt(round) + 11n } : undefined

/**
 * Checks extended simulate options against the capabilities the node reported, throwing for what it doesn't allow.
 * Shared with `QueryManager`, which validates the same options.
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
  protocolOverride: SimulateProtocolOverride | undefined,
): SimulateGroupOutcome {
  const base = { groupIndex, round: raw.round, ...(protocolOverride ? { protocolOverride } : {}) }
  return raw.ok ? { ...base, ok: true, result: toGroupResult(built, raw.result, response) } : { ...base, ok: false, error: raw.error }
}

/** The protocol override of one request at one round, with the notes' group indexes moved by `offset` (the request's first group). */
function protocolOverrideAt(
  response: DTSimulateResponseLike,
  roundIndex: number | undefined,
  offset: number,
): SimulateProtocolOverride | undefined {
  const o = roundIndex === undefined ? response.protocolOverride : response.roundResults?.[roundIndex]?.protocolOverride
  return offsetProtocolOverride(o, offset)
}

/**
 * Extended simulate on dtalgod: several transaction groups in one request (one after the other in one block, or in
 * parallel), and the same groups at several rounds in one request.
 *
 * The groups are simulated without signatures (like `simulate({ skipSignatures: true })`), so this is for reads and
 * dry runs. Needs dt-algosdk (without it, every method throws a `DTNotAvailableError`) and dtalgod: on stock algod,
 * `groups` and `rounds` throw dt-algosdk's `DTUnsupportedError` before sending anything. The node's capabilities
 * (`algorand.client.capabilities()`), which tell the two apart, are asked for once per algod client.
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
   * Simulates several transaction groups in one request, at the latest round or at a past `round`.
   *
   * The node's limits (see `limits()`) apply: at most `maxTxnGroups` groups per request, and an `extraOpcodeBudget` above
   * `maxExtraOpcodeBudget` throws.
   *
   * By default the groups run one after the other in one block: later groups see the effects of earlier ones, and a
   * failed group is rolled back without stopping the later ones. With `parallel`, each group runs on its own against
   * the starting state.
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
    checkValidityWindow(rest as { validityWindow?: string })
    rest.signal?.throwIfAborted()
    // The capabilities are cached per client and shared, so they are read without the signal
    const capabilities = await requireDTNode(this._clientManager.algod, 'Simulating several groups')
    const limit = concurrencyLimiter(checkConcurrency(rest.concurrency))
    const built = await this.buildGroups(composers, validityAt(round))
    const [outcomes] = await this.send(built, rest, { round }, capabilities, limit)
    return outcomes.groups
  }

  /**
   * Returns the node's simulate limits: how many groups and `rounds` entries a request may hold, the most
   * `extraOpcodeBudget`, and the factor on the unnamed-resource limits. `groups` and `rounds` keep to them.
   *
   * They are the `simulate` part of the node's capabilities (`algorand.client.capabilities()`, which also says whether the
   * node is dtalgod at all, and which features it has on), asked for once per algod client. Stock algod, which has no
   * capabilities endpoint, gets stock algod's limits.
   *
   * @returns The node's simulate limits
   * @throws DTNotAvailableError if the loaded algosdk is not dt-algosdk
   * @example
   * ```typescript
   * const { maxTxnGroups, maxRounds } = await algorand.simulate.limits()
   * ```
   */
  public async limits(): Promise<SimulateLimits> {
    requireDTSdk('Reading the simulate limits')
    return (await getCapabilities(this._clientManager.algod))!.simulate
  }

  /**
   * Simulates the same transaction groups at several past rounds, in as few requests as the node's limits allow.
   *
   * The rounds are packed into windows of at most `maxRounds` rounds that span at most 1,000 rounds, and the groups are
   * built again for each window, valid at its rounds; transactions that set their own `firstValidRound` /
   * `lastValidRound` keep them. The windows are sent in parallel. With `validityWindow`, a window can span any number of
   * rounds: the groups are built valid from its first round for at most 1,000 rounds, and the node moves (`rewrite`) or
   * ignores (`skip`) that validity window at the later rounds.
   *
   * `maxRounds` defaults to the node's limit (see `limits()`). On a node with `rounds` disabled, each round is its own
   * request.
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
   *
   * // Years apart, under today's rules
   * const now = await algorand.simulate.rounds(composer, [20_000_000n, 45_000_000n], { validityWindow: 'rewrite', protocol: 'latest' })
   * for (const { round, protocolOverride } of now) console.log(round, protocolOverride?.from, '->', protocolOverride?.to)
   * ```
   */
  public async rounds(
    composers: TransactionComposer | TransactionComposer[],
    rounds: Round[],
    options?: SimulateRoundsOptions,
  ): Promise<SimulateRoundOutcome[]> {
    const { maxRounds: maxRoundsOption, ...rest } = options ?? {}
    const groups = Array.isArray(composers) ? composers : [composers]
    if (rounds.length === 0) return []
    const tt = requireDTSdk('Simulating at several rounds')
    checkValidityWindow(rest)
    const limit = concurrencyLimiter(checkConcurrency(rest.concurrency))
    rest.signal?.throwIfAborted()
    // The capabilities are cached per client and shared, so they are read without the signal
    const capabilities = await requireDTNode(this._clientManager.algod, 'Simulating at several rounds')
    const maxRounds = maxRoundsOption ?? capabilities.simulate.maxRounds
    if (maxRounds === 0) return await this.roundByRound(groups, rounds, rest, capabilities, limit)
    // With a validity window mode the rounds of a request needn't fit in one transaction's validity window
    const { windows, positions } = tt.packSimulateRounds(rounds, { maxRounds, ...(rest.validityWindow ? { maxSpan: null } : {}) })

    // Build one after the other (a composer can only build one validity window at a time), then send `concurrency` at a time
    const builtWindows: BuiltTransactions[][] = []
    for (const w of windows) {
      builtWindows.push(await this.buildGroups(groups, { firstValidRound: w.firstValid, lastValidRound: w.lastValid }))
    }
    const results = await Promise.all(windows.map((w, i) => this.send(builtWindows[i], rest, { rounds: w.rounds }, capabilities, limit)))

    return positions.map(({ window, roundIndex }, i) => {
      const { groups, protocolOverride } = results[window][roundIndex]
      return { round: BigInt(rounds[i]), groups, ...(protocolOverride ? { protocolOverride } : {}) }
    })
  }

  /** Simulates the groups at each round in a request of its own, with `round` set: for a node with `rounds` disabled. */
  private async roundByRound(
    composers: TransactionComposer[],
    rounds: Round[],
    options: Omit<SimulateRoundsOptions, 'maxRounds'>,
    capabilities: Capabilities,
    limit: ReturnType<typeof concurrencyLimiter>,
  ): Promise<SimulateRoundOutcome[]> {
    // The transactions are built valid at each round, so a validity window mode isn't needed (and needs `rounds`)
    const { validityWindow, ...rest } = options
    const unique = [...new Set(rounds.map((r) => BigInt(r)))]
    const zero = unique.find((r) => r < 1n)
    if (zero !== undefined) {
      throw new RangeError(`Can't simulate at round ${zero} in rounds: give past rounds (look the latest round up with status())`)
    }
    // Build one after the other (a composer can only build one validity window at a time), then send `concurrency` at a time
    const built: BuiltTransactions[][] = []
    for (const r of unique) built.push(await this.buildGroups(composers, validityAt(r)))
    const results = await Promise.all(unique.map((r, i) => this.send(built[i], rest, { round: r }, capabilities, limit)))
    return rounds.map((r) => {
      const [{ groups, protocolOverride }] = results[unique.indexOf(BigInt(r))]
      return { round: BigInt(r), groups, ...(protocolOverride ? { protocolOverride } : {}) }
    })
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
      // Clear any group ID so that the request assigns one for the group as simulated
      if (b.transactions.length > 1) b.transactions.forEach((t) => (t.group = undefined))
      built.push(b)
    }
    return built
  }

  /** Sends the groups (split into requests if parallel), returning the outcomes per round of the request (one round without `rounds`). */
  private async send(
    built: BuiltTransactions[],
    options: ExtendedSimulateOptions & Pick<SimulateRoundsOptions, 'validityWindow'>,
    at: { round?: Round; rounds?: bigint[] },
    capabilities: Capabilities,
    limit: ReturnType<typeof concurrencyLimiter>,
  ): Promise<{ groups: SimulateGroupOutcome[]; protocolOverride?: SimulateProtocolOverride }[]> {
    const tt = requireDTSdk('Simulating several groups')
    const { parallel = false, maxGroups: maxGroupsOption, protocol, validityWindow, signal, concurrency, ...raw } = options
    signal?.throwIfAborted()
    // Fetch options for each request: the signal goes to fetch, never into the request body
    const fetchOptions = signal ? { signal } : undefined
    const maxGroups = maxGroupsOption ?? capabilities.simulate.maxTxnGroups
    if (!Number.isInteger(maxGroups) || maxGroups < 1) throw new RangeError(`maxGroups must be a positive integer, not ${maxGroups}`)
    if (!parallel && built.length > maxGroups) {
      throw new Error(
        `Can't simulate ${built.length} groups one after the other: ${maxGroupsOption === undefined ? 'the node takes' : 'maxGroups allows'} at most ${maxGroups} per request (use parallel to split them across requests)`,
      )
    }
    checkSimulateLimits(capabilities, protocol, raw)
    const chunks = parallel ? chunk(built, maxGroups) : [built]
    const algod = this._clientManager.dtAlgod
    // Parallel groups split across requests must all run at the same round, even if a new block comes in between
    let round = at.round || undefined
    if (chunks.length > 1 && !round && !at.rounds) round = (await this._clientManager.algod.status().do(undefined, fetchOptions)).lastRound

    const responses = await Promise.all(
      chunks.map(async (groups) => {
        const request = tt.dtModels.DTSimulateRequest.fromTransactions(
          groups.map((g) => g.transactions),
          // A group alone is sent as a plain upstream request: one group in parallel runs as it does alone
          { ...raw, allowEmptySignatures: true, fixSigners: true, parallelGroups: (parallel && groups.length > 1) || undefined, round },
        )
        let call = algod.simulateTransactions(request)
        if (at.rounds) call = call.rounds(at.rounds)
        if (validityWindow === 'skip') call = call.skipValidityWindow()
        if (validityWindow === 'rewrite') call = call.rewriteValidityWindow()
        if (protocol) call = call.protocol(protocol)
        return await limit(() => call.do(undefined, fetchOptions))
      }),
    )

    const offsets = chunks.map((_, c) => chunks.slice(0, c).reduce((n, g) => n + g.length, 0))
    const roundCount = at.rounds ? at.rounds.length : 1
    return Array.from({ length: roundCount }, (_, roundIndex) => {
      const overrides = responses.map((response, c) => protocolOverrideAt(response, at.rounds ? roundIndex : undefined, offsets[c]))
      const protocolOverride = mergeProtocolOverrides(overrides)
      const groups = chunks.flatMap((groups, c) => {
        const response: DTSimulateResponseLike = responses[c]
        const row = response.groupResults(groups.length)[roundIndex]
        // A request whose round failed has no override: its groups get none either
        return row.map((raw, g) => toOutcome(raw, offsets[c] + g, groups[g], response, overrides[c] && protocolOverride))
      })
      return { groups, ...(protocolOverride ? { protocolOverride } : {}) }
    })
  }
}
