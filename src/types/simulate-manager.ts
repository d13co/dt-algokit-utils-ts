import algosdk from 'algosdk'
import { Buffer } from 'buffer'
import { getABIReturnValue } from '../transaction/transaction'
import { ClientManager } from './client-manager'
import { BuiltTransactions, RawSimulateOptions, TransactionComposer } from './composer'
import {
  DTSimulateResponseLike,
  OptionalDTFeature,
  RawSimulateGroupOutcome,
  Round,
  SimulateProtocolNote,
  SimulateProtocolOverride,
  requireDTSdkFeatures,
} from './dt-support'
import { SendAtomicTransactionComposerResults } from './transaction'
import modelsv2 = algosdk.modelsv2

/** The default most groups per simulate request (dtalgod's `MaxAPISimulateGroups` default). */
export const DEFAULT_MAX_SIMULATE_GROUPS = 16
/** The default most rounds per simulate request (dtalgod's `MaxAPISimulateRounds` default). */
export const DEFAULT_MAX_SIMULATE_ROUNDS = 16

/** Options for an extended simulate request. */
export type ExtendedSimulateOptions = Omit<RawSimulateOptions, 'allowEmptySignatures' | 'fixSigners' | 'round'> & {
  /**
   * Simulate each group on its own against the starting state, concurrently, instead of one after the other in one
   * block. Parallel groups don't see each other's effects.
   */
  parallel?: boolean
  /**
   * The most groups the node takes per request (`MaxAPISimulateGroups`, default 16). Parallel groups beyond it are split
   * across requests; sequential groups can't be split, so more than this throws.
   */
  maxGroups?: number
  /**
   * Simulate under a later consensus protocol, as if an upgrade to it took effect right after the round simulated at:
   * its programs, limits, fees and other parameters apply, to programs deployed earlier too. A consensus version string,
   * `v24` to `v42` for a mainline one, `latest` (the protocol of the block after the node's latest one) or `future`
   * (vFuture, only on a node with `EnableDeveloperAPI`). It must be a later protocol of the chain than the one the round
   * really ran; the protocol the round really ran is simulated as it is.
   *
   * Each outcome's `protocolOverride` says how it applied. An unknown name, or `future` without the developer API, fails
   * the whole request. A protocol that isn't a later one of the chain fails the request with `simulate.groups`, or that
   * round (`kind: 'round'`) with `simulate.rounds`.
   * Needs dtalgod and a version of the fork with the `simulate-protocol` feature.
   */
  protocol?: string
}

/** Options to simulate several groups at one round. */
export type SimulateGroupsOptions = ExtendedSimulateOptions & {
  /**
   * Simulate as of the end of this past round (0 or `undefined` for the latest round). Needs dtalgod time travel for
   * rounds older than the node's `MaxAcctLookback`. Transactions that don't set their own validity are built valid at
   * this round.
   */
  round?: Round
}

/** Options to simulate groups at several rounds. */
export type SimulateRoundsOptions = ExtendedSimulateOptions & {
  /** The most rounds the node takes per request (`MaxAPISimulateRounds`, default 16). More rounds are split across requests. */
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
   * Needs dtalgod and a version of the fork with the `validity-window` feature.
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

/** The optional fork features that the options need, after checking `validityWindow`. */
const optionalFeatures = (options: { protocol?: string; validityWindow?: string }): OptionalDTFeature[] => {
  const { validityWindow } = options
  if (validityWindow !== undefined && validityWindow !== 'skip' && validityWindow !== 'rewrite') {
    throw new Error(`validityWindow must be 'skip' or 'rewrite', not ${JSON.stringify(validityWindow)}`)
  }
  return [...(validityWindow ? (['validity-window'] as const) : []), ...(options.protocol ? (['simulate-protocol'] as const) : [])]
}

/** The order the node lists protocol notes in; codes it adds later go after these. */
const PROTOCOL_NOTE_ORDER: readonly string[] = [
  'semantics-changed',
  'no-heartbeat-challenges',
  'no-load-history',
  'block-incentive-fields',
  'block-hash-fields',
  'online-stake-includes-expired',
  'account-incentive-fields',
  'app-version-starts-at-upgrade',
]

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/** Turns a successful group result into the same shape as `TransactionComposer.simulate` returns. */
function toGroupResult(
  built: BuiltTransactions,
  group: modelsv2.SimulateTransactionGroupResult,
  simulateResponse: modelsv2.SimulateResponse,
): SimulateGroupResult {
  const { transactions, methodCalls } = built
  const confirmations = group.txnResults.map((t) => t.txnResult)
  const returns = [...methodCalls.entries()].map(([index, method]) =>
    getABIReturnValue(
      algosdk.AtomicTransactionComposer.parseMethodResponse(
        method,
        { txID: transactions[index].txID(), rawReturnValue: new Uint8Array(), method },
        confirmations[index],
      ),
      method.returns.type,
    ),
  )
  return {
    confirmations,
    transactions,
    txIds: transactions.map((t) => t.txID()),
    groupId: Buffer.from(transactions[0].group ?? new Uint8Array()).toString('base64'),
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
  if (!o || !o.notes || offset === 0) return o
  return {
    ...o,
    notes: o.notes.map((n) => (n.hits ? { ...n, hits: n.hits.map((h) => ({ ...h, group: h.group + offset })) } : n)),
  }
}

/** Merges the protocol overrides of the requests that parallel groups were split across, at the same round. */
function mergeProtocolOverrides(overrides: (SimulateProtocolOverride | undefined)[]): SimulateProtocolOverride | undefined {
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

/**
 * Extended simulate on dtalgod: several transaction groups in one request (one after the other in one block, or in
 * parallel), and the same groups at several rounds in one request.
 *
 * The groups are simulated without signatures (like `simulate({ skipSignatures: true })`), so this is for reads and
 * dry runs. Needs the time-travel fork of algosdk (without it, every method throws a `DTNotAvailableError`)
 * and dtalgod (a stock node throws the fork's `DTUnsupportedError`).
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
    const validity = round ? { firstValidRound: BigInt(round) + 1n, lastValidRound: BigInt(round) + 11n } : undefined
    const built = await this.buildGroups(composers, validity)
    const [outcomes] = await this.send(built, rest, { round })
    return outcomes.groups
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
    const { maxRounds = DEFAULT_MAX_SIMULATE_ROUNDS, ...rest } = options ?? {}
    const groups = Array.isArray(composers) ? composers : [composers]
    if (rounds.length === 0) return []
    const tt = requireDTSdkFeatures('Simulating at several rounds', optionalFeatures(rest))
    // With a validity window mode the rounds of a request needn't fit in one transaction's validity window
    const { windows, positions } = tt.packSimulateRounds(rounds, { maxRounds, ...(rest.validityWindow ? { maxSpan: null } : {}) })

    // Build one after the other (a composer can only build one validity window at a time), then send in parallel
    const builtWindows: BuiltTransactions[][] = []
    for (const w of windows) {
      builtWindows.push(await this.buildGroups(groups, { firstValidRound: w.firstValid, lastValidRound: w.lastValid }))
    }
    const results = await Promise.all(windows.map((w, i) => this.send(builtWindows[i], rest, { rounds: w.rounds })))

    return positions.map(({ window, roundIndex }, i) => {
      const { groups, protocolOverride } = results[window][roundIndex]
      return { round: BigInt(rounds[i]), groups, ...(protocolOverride ? { protocolOverride } : {}) }
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
  ): Promise<{ groups: SimulateGroupOutcome[]; protocolOverride?: SimulateProtocolOverride }[]> {
    const tt = requireDTSdkFeatures('Simulating several groups', optionalFeatures(options))
    const { parallel = false, maxGroups = DEFAULT_MAX_SIMULATE_GROUPS, protocol, validityWindow, ...raw } = options
    if (!parallel && built.length > maxGroups) {
      throw new Error(
        `Can't simulate ${built.length} groups one after the other: the node takes at most ${maxGroups} per request (set maxGroups if the node allows more, or use parallel)`,
      )
    }
    const chunks = parallel ? chunk(built, maxGroups) : [built]
    const algod = this._clientManager.dtAlgod
    // Parallel groups split across requests must all run at the same round, even if a new block comes in between
    let round = at.round || undefined
    if (chunks.length > 1 && !round && !at.rounds) round = (await this._clientManager.algod.status().do()).lastRound

    const responses = await Promise.all(
      chunks.map(async (groups) => {
        const request = tt.dtModels.DTSimulateRequest.fromTransactions(
          groups.map((g) => g.transactions),
          { ...raw, allowEmptySignatures: true, fixSigners: true, parallelGroups: parallel || undefined, round },
        )
        let call = algod.simulateTransactions(request)
        if (at.rounds) call = call.rounds(at.rounds)
        if (validityWindow === 'skip') call = call.skipValidityWindow()
        if (validityWindow === 'rewrite') call = call.rewriteValidityWindow()
        if (protocol) call = call.protocol(protocol)
        return await call.do()
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
