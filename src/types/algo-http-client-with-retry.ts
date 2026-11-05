import { IntDecoding, parseJSON, stringifyJSON } from 'algosdk'
import { BaseHTTPClientResponse, Query, URLTokenBaseHTTPClient } from 'algosdk/client'
import { Config } from '../config'
import { getDTRetry } from './dt-support'
import { EventType } from './lifecycle-events'
import type { RetryOptionsLike, RetryPolicyLike, RetryWaitLike } from './retry'

/**
 * Marks a client that retries, so dt-algosdk's `withRetry` doesn't wrap it again (dt-algosdk's `RETRYING_CLIENT`, a
 * registered symbol).
 */
export const RETRYING_CLIENT: unique symbol = Symbol.for('dt-algosdk.retrying-client') as never

/** Calls `f`, ignoring what it throws or a promise it rejects: a broken listener must not break the request. */
function callQuietly(f: () => unknown) {
  try {
    const result = f()
    if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => {})
  } catch {
    // ignored
  }
}

/**
 * A HTTP Client that wraps the Algorand SDK HTTP Client with retries.
 *
 * With dt-algosdk (feature `retry-policy`), requests (algod, indexer, simulate, query, deltas, ...) are retried by its
 * retry policy ("Retries" in docs/dt-fork.md): up to 5 tries; 408, 429, 500, 502, 503, 504 and network errors; not a 503
 * for history the node can't serve, nor a 504 from a request under the node's time limit, nor a transaction submit the
 * node may have taken; waits of 0, 2, 4, 8 s, at least a 429's or 503's `Retry-After` (giving up above 30 s), and at least
 * 1 s for a 429 or busy 503 without one, a refused connection or a browser's failed fetch. The policy can be changed per client (`retry` in the constructor or
 * `AlgoClientConfig`) and globally (`Config.configure({ retry })`), the client's fields winning. Each wait is logged
 * (`Config.logger.warn`), emitted as `EventType.RetryWait` on `Config.events`, passed to the policy's `onWait`, and
 * listed in {@link waits} while it lasts.
 *
 * With stock algosdk, requests are retried as upstream algokit-utils does (up to 5 tries, at once and then after 2, 4,
 * 8 s), stopping when the request's `signal` aborts; the `retry` options have no effect and no event is emitted.
 */
export class AlgoHttpClientWithRetry extends URLTokenBaseHTTPClient {
  private static readonly MAX_TRIES = 5
  private static readonly MAX_BACKOFF_MS = 10000

  // These lists come from https://visionmedia.github.io/superagent/#retrying-requests
  // which is the underlying library used by algosdk - but the CloudFlare specific 52X status codes have been removed
  private static readonly RETRY_STATUS_CODES = [408, 413, 429, 500, 502, 503, 504]
  private static readonly RETRY_ERROR_CODES = [
    'ETIMEDOUT',
    'ECONNRESET',
    'EADDRINUSE',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
    'EPROTO', // We get this intermittently with AlgoNode API
  ]

  /** This client retries: dt-algosdk's `withRetry` returns it as is. */
  readonly [RETRYING_CLIENT] = true

  /** This client's retry policy fields, which win over `Config.retry`; `false` for no retries. Needs dt-algosdk. */
  readonly retry?: RetryOptionsLike

  private readonly active = new Set<RetryWaitLike>()

  /**
   * @param tokenHeader The token header, as for `URLTokenBaseHTTPClient`
   * @param baseServer The server URL
   * @param port The port
   * @param defaultHeaders Headers sent with every request
   * @param retry This client's retry policy fields, which win over `Config.retry`; `false` for no retries. Needs dt-algosdk
   */
  constructor(
    tokenHeader: ConstructorParameters<typeof URLTokenBaseHTTPClient>[0],
    baseServer: string,
    port?: string | number,
    defaultHeaders?: Record<string, string>,
    retry?: RetryOptionsLike,
  ) {
    super(tokenHeader, baseServer, port, defaultHeaders)
    this.retry = retry
  }

  /** The requests waiting to be retried now, one entry each (dt-algosdk only). */
  get waits(): readonly RetryWaitLike[] {
    return [...this.active]
  }

  /** Of the requests waiting now, the one that waits longest, if any (dt-algosdk only). */
  get waiting(): RetryWaitLike | undefined {
    let latest: RetryWaitLike | undefined
    for (const wait of this.active) if (!latest || wait.until > latest.until) latest = wait
    return latest
  }

  /** The abort signal in fetch options passed as `customOptions`, if any. */
  private static signalOf(customOptions?: Record<string, unknown>): AbortSignal | undefined {
    // Duck-typed: a signal from another realm (e.g. jsdom) isn't an instance of this one's AbortSignal
    const signal = customOptions?.signal as AbortSignal | undefined
    return signal && typeof signal === 'object' && 'aborted' in signal ? signal : undefined
  }

  /** Waits `ms`, rejecting with the signal's reason as soon as it aborts. */
  private static sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal!.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** The policy for a request: `Config.retry` with this client's fields over it, and an `onWait` that also logs and emits. */
  private retryOptions(formatRetryWait: (wait: RetryWaitLike) => string): RetryOptionsLike {
    // `false` is `maxTries: 1`, so a client's fields over a global `false` retry only if they set `maxTries`
    const fieldsOf = (options: RetryOptionsLike | undefined): Partial<RetryPolicyLike> | undefined =>
      options === false ? { maxTries: 1 } : options
    const policy: Partial<RetryPolicyLike> = {}
    for (const fields of [fieldsOf(Config.retry), fieldsOf(this.retry)]) {
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value !== undefined) (policy as Record<string, unknown>)[key] = value
      }
    }
    const onWait = policy.onWait
    policy.onWait = (wait) => {
      callQuietly(() => Config.logger.warn(`${formatRetryWait(wait)}: ${wait.method.toUpperCase()} ${wait.path} failed: ${wait.error}`))
      callQuietly(() => Config.events.emitAsync(EventType.RetryWait, wait))
      if (onWait) callQuietly(() => onWait(wait))
    }
    return policy
  }

  private async callWithRetry(
    method: 'get' | 'post' | 'delete',
    path: string,
    func: () => Promise<BaseHTTPClientResponse>,
    customOptions?: Record<string, unknown>,
  ): Promise<BaseHTTPClientResponse> {
    const signal = AlgoHttpClientWithRetry.signalOf(customOptions)
    const dt = getDTRetry()
    if (dt) {
      return dt.callWithRetry(func, { method, path, signal }, this.retryOptions(dt.formatRetryWait), this.active)
    }
    // Stock algosdk: upstream algokit-utils' loop, stopping on an abort
    let response: BaseHTTPClientResponse | undefined
    let numTries = 1
    do {
      signal?.throwIfAborted()
      try {
        response = await func()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        // An aborted request is never retried
        if (signal?.aborted) throw err
        if (numTries >= AlgoHttpClientWithRetry.MAX_TRIES) {
          throw err
        }
        // Only retry for one of the hardcoded conditions; Node's fetch puts the network error code on `cause`
        if (!(
          AlgoHttpClientWithRetry.RETRY_ERROR_CODES.includes(err.code ?? err.cause?.code) ||
          AlgoHttpClientWithRetry.RETRY_STATUS_CODES.includes(Number(err.status)) ||
          ('response' in err && AlgoHttpClientWithRetry.RETRY_STATUS_CODES.includes(Number(err.response?.status)))
        )) {
          throw err
        }
        // Retry immediately the first time, then exponentially backoff.
        const delayTimeMs = numTries == 1 ? 0 : Math.min(1000 * Math.pow(2, numTries - 1), AlgoHttpClientWithRetry.MAX_BACKOFF_MS)
        if (delayTimeMs > 0) {
          await AlgoHttpClientWithRetry.sleep(delayTimeMs, signal)
        }
        Config.logger.warn(`algosdk request failed ${numTries} times. Retrying in ${delayTimeMs}ms: ${err}`)
      }
    } while (!response && ++numTries <= AlgoHttpClientWithRetry.MAX_TRIES)
    return response!
  }

  async get(
    relativePath: string,
    query?: Query<string>,
    requestHeaders: Record<string, string> = {},
    customOptions?: Record<string, unknown>,
  ): Promise<BaseHTTPClientResponse> {
    const response = await this.callWithRetry(
      'get',
      relativePath,
      () => super.get(relativePath, query, requestHeaders, customOptions),
      customOptions,
    )
    if (
      relativePath.startsWith('/v2/accounts/') &&
      relativePath.endsWith('/created-applications') &&
      response.status === 200 &&
      query?.['include-all']?.toString() === 'true'
    ) {
      // todo: Temporary hack
      // Indexer get created applications by account returns approvalProgram and clearStateProgram as null, which breaks the algosdk@3 decoder
      // instead we will detect this call and set them to empty byte arrays
      try {
        const json = parseJSON(Buffer.from(response.body).toString(), { intDecoding: IntDecoding.MIXED })
        if (json.applications) {
          for (const app of json.applications) {
            if (app.params) {
              if (app.params['approval-program'] === null) {
                app.params['approval-program'] = ''
              }
              if (app.params['clear-state-program'] === null) {
                app.params['clear-state-program'] = ''
              }
            }
          }
          response.body = Buffer.from(stringifyJSON(json))
        }
      } catch (e) {
        // Make this hack resilient so we never break the app
        Config.logger.warn('Failed to fix indexer response for created applications', e)
      }
    }
    return response
  }

  async post(
    relativePath: string,
    data: Uint8Array,
    query?: Query<string>,
    requestHeaders: Record<string, string> = {},
    customOptions?: Record<string, unknown>,
  ): Promise<BaseHTTPClientResponse> {
    return await this.callWithRetry(
      'post',
      relativePath,
      () => super.post(relativePath, data, query, requestHeaders, customOptions),
      customOptions,
    )
  }

  async delete(
    relativePath: string,
    data: Uint8Array,
    query?: Query<string>,
    requestHeaders: Record<string, string> = {},
    customOptions?: Record<string, unknown>,
  ): Promise<BaseHTTPClientResponse> {
    return await this.callWithRetry(
      'delete',
      relativePath,
      () => super.delete(relativePath, data, query, requestHeaders, customOptions),
      customOptions,
    )
  }
}
