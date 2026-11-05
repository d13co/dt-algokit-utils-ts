import { AsyncEventEmitter } from './async-event-emitter'
import { Logger, consoleLogger, nullLogger } from './logging'
import type { RetryOptionsLike } from './retry'

/** The AlgoKit configuration type */
export interface Config {
  /** Logger */
  logger: Logger
  /** Whether or not debug mode is enabled */
  debug: boolean
  /** The path to the project root directory */
  projectRoot: string | null
  /** Indicates whether to trace all operations */
  traceAll: boolean
  /** The size of the trace buffer in megabytes */
  traceBufferSizeMb: number
  /** The maximum depth to search for a specific file */
  maxSearchDepth: number
  /**
   * Whether to enable populateAppCallResources in sendParams by default.
   * Default value is false.
   */
  populateAppCallResources: boolean

  events: AsyncEventEmitter

  /**
   * How the algod and indexer clients that algokit-utils makes retry failed requests: the retry policy fields to change,
   * or `false` for no retries. Read on every request, so it applies to clients made before `configure`. A client's own
   * `retry` (`AlgoClientConfig.retry`) wins, field by field (`false` counting as `{ maxTries: 1 }`). Needs dt-algosdk (feature `retry-policy`): with stock
   * algosdk the clients retry as upstream algokit-utils does, and this has no effect. See "Retries" in docs/dt-fork.md.
   */
  retry?: RetryOptionsLike
}

/** Updatable AlgoKit config */
export class UpdatableConfig implements Readonly<Config> {
  private config: Config

  get populateAppCallResources() {
    return this.config.populateAppCallResources
  }

  get logger() {
    return this.config.logger
  }

  get debug() {
    return this.config.debug
  }

  get projectRoot() {
    return this.config.projectRoot
  }

  get traceAll() {
    return this.config.traceAll
  }

  get traceBufferSizeMb() {
    return this.config.traceBufferSizeMb
  }

  get maxSearchDepth() {
    return this.config.maxSearchDepth
  }

  get events() {
    return this.config.events
  }

  get retry() {
    return this.config.retry
  }

  /**
   * Returns the current logger, or the null logger if true is passed in to `returnNullLogger`
   * @param returnNullLogger Whether or not to return the null logger
   * @returns The requested logger
   */
  getLogger(returnNullLogger?: boolean) {
    if (returnNullLogger) {
      return nullLogger
    }

    return this.logger
  }

  /**
   * Temporarily run with debug set to true.
   * @param lambda A lambda expression with code to run with debug config set to true
   */
  withDebug(lambda: () => unknown) {
    const original = this.config.debug
    try {
      this.config.debug = true
      lambda()
    } finally {
      this.config.debug = original
    }
  }

  constructor() {
    this.config = {
      logger: consoleLogger,
      debug: false,
      projectRoot: null,
      traceAll: false,
      traceBufferSizeMb: 256,
      maxSearchDepth: 10,
      populateAppCallResources: true,
      events: new AsyncEventEmitter(),
    }
  }

  /**
   * Update the AlgoKit configuration with your own configuration settings
   * @param newConfig Partial or complete config to replace
   */
  configure(newConfig: Partial<Config>) {
    this.config = { ...this.config, ...newConfig }
  }
}
