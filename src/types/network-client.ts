import { TokenHeader } from 'algosdk'
import type { RetryOptionsLike } from './retry'

/** Config for an Algorand SDK client. */
export interface AlgoClientConfig {
  /** Base URL of the server e.g. http://localhost, https://testnet-api.algonode.cloud/, etc. */
  server: string
  /** The port to use e.g. 4001, 443, etc. */
  port?: string | number
  /** The token to use for API authentication (or undefined if none needed) - can be a string, or an object with the header key => value */
  token?: string | TokenHeader
  /**
   * How this algod or indexer client retries failed requests: the retry policy fields to change, or `false` for no
   * retries. Wins, field by field, over `Config.retry` (`false` counting as `{ maxTries: 1 }`). No effect on kmd clients, which don't retry, or with stock
   * algosdk (it needs dt-algosdk's `retry-policy`). See "Retries" in docs/dt-fork.md.
   */
  retry?: RetryOptionsLike
}

/** Configuration for algod, indexer and kmd clients. */
export interface AlgoConfig {
  /** Algod client configuration */
  algodConfig: AlgoClientConfig
  /** Indexer client configuration */
  indexerConfig?: AlgoClientConfig
  /** Kmd configuration */
  kmdConfig?: AlgoClientConfig
}

/** Details of the current network. */
export interface NetworkDetails {
  /** Whether or not the network is TestNet. */
  isTestNet: boolean
  /** Whether or not the network is MainNet. */
  isMainNet: boolean
  /** Whether or not the network is LocalNet. */
  isLocalNet: boolean
  /** The genesis ID of the current network. */
  genesisId: string
  /** The base64 genesis hash of the current network. */
  genesisHash: string
}

/**
 * Returns true if the given network genesisId is associated with a LocalNet network.
 * @param genesisId The network genesis ID
 * @returns Whether the given genesis ID is associated with a LocalNet network
 */
export function genesisIdIsLocalNet(genesisId: string) {
  return genesisId === 'devnet-v1' || genesisId === 'sandnet-v1' || genesisId === 'dockernet-v1'
}
