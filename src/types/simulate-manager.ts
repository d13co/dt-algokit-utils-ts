import algosdk from 'algosdk'
import { Buffer } from 'buffer'
import { getABIReturnValue } from '../transaction/transaction'
import { ClientManager } from './client-manager'
import { BuiltTransactions, RawSimulateOptions, TransactionComposer } from './composer'
import { RawSimulateGroupOutcome, Round, DTSimulateResponseLike, requireDTSdk } from './dt-support'
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
} & ({ ok: true; result: SimulateGroupResult } | { ok: false; error: SimulateGroupError })

/** The outcomes of the groups at one round. */
export interface SimulateRoundOutcome {
  /** The round, as given. */
  round: bigint
  /** The outcome of each group, in the order the composers were given. */
  groups: SimulateGroupOutcome[]
}

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
): SimulateGroupOutcome {
  return raw.ok
    ? { groupIndex, round: raw.round, ok: true, result: toGroupResult(built, raw.result, response) }
    : { groupIndex, round: raw.round, ok: false, error: raw.error }
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
   * `lastValidRound` keep them. The windows are sent in parallel.
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
    const { maxRounds = DEFAULT_MAX_SIMULATE_ROUNDS, ...rest } = options ?? {}
    const groups = Array.isArray(composers) ? composers : [composers]
    if (rounds.length === 0) return []
    const tt = requireDTSdk('Simulating at several rounds')
    const { windows, positions } = tt.packSimulateRounds(rounds, { maxRounds })

    // Build one after the other (a composer can only build one validity window at a time), then send in parallel
    const builtWindows: BuiltTransactions[][] = []
    for (const w of windows) {
      builtWindows.push(await this.buildGroups(groups, { firstValidRound: w.firstValid, lastValidRound: w.lastValid }))
    }
    const results = await Promise.all(windows.map((w, i) => this.send(builtWindows[i], rest, { rounds: w.rounds })))

    return positions.map(({ window, roundIndex }, i) => ({
      round: BigInt(rounds[i]),
      groups: results[window][roundIndex].groups,
    }))
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
    options: ExtendedSimulateOptions,
    at: { round?: Round; rounds?: bigint[] },
  ): Promise<{ groups: SimulateGroupOutcome[] }[]> {
    const tt = requireDTSdk('Simulating several groups')
    const { parallel = false, maxGroups = DEFAULT_MAX_SIMULATE_GROUPS, ...raw } = options
    if (!parallel && built.length > maxGroups) {
      throw new Error(
        `Can't simulate ${built.length} groups one after the other: the node takes at most ${maxGroups} per request (set maxGroups if the node allows more, or use parallel)`,
      )
    }
    const chunks = parallel ? chunk(built, maxGroups) : [built]
    const algod = this._clientManager.dtAlgod

    const responses = await Promise.all(
      chunks.map(async (groups) => {
        const request = tt.dtModels.DTSimulateRequest.fromTransactions(
          groups.map((g) => g.transactions),
          { ...raw, allowEmptySignatures: true, fixSigners: true, parallelGroups: parallel || undefined, round: at.round || undefined },
        )
        let call = algod.simulateTransactions(request)
        if (at.rounds) call = call.rounds(at.rounds)
        return await call.do()
      }),
    )

    const roundCount = at.rounds ? at.rounds.length : 1
    return Array.from({ length: roundCount }, (_, roundIndex) => ({
      groups: chunks.flatMap((groups, c) => {
        const response: DTSimulateResponseLike = responses[c]
        const row = response.groupResults(groups.length)[roundIndex]
        const offset = chunks.slice(0, c).reduce((n, g) => n + g.length, 0)
        return row.map((raw, g) => toOutcome(raw, offset + g, groups[g], response))
      }),
    }))
  }
}
