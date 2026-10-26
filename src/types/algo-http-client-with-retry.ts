import { IntDecoding, parseJSON, stringifyJSON } from 'algosdk'
import { BaseHTTPClientResponse, Query, URLTokenBaseHTTPClient } from 'algosdk/client'
import { Config } from '../config'

/**
 * A HTTP Client that wraps the Algorand SDK HTTP Client with retries.
 *
 * A 429 or 503 with a `Retry-After` header waits at least that long before the next try (capped at 10 s). A 504 from
 * `POST /v2/query` (the node's time limit) is not retried.
 */
export class AlgoHttpClientWithRetry extends URLTokenBaseHTTPClient {
  private static readonly MAX_TRIES = 5
  private static readonly MAX_BACKOFF_MS = 10000

  // These lists come from https://visionmedia.github.io/superagent/#retrying-requests
  // which is the underlying library used by algosdk - but the CloudFlare specific 52X status codes have been removed
  private static readonly RETRY_STATUS_CODES = [408, 413, 429, 500, 502, 503, 504]
  /**
   * The status codes retried for `POST /v2/query`: all but 504, which is the node's time limit. A retry would repeat the
   * whole (up to `time-limit-seconds`) work; the caller splits the request instead.
   */
  private static readonly QUERY_RETRY_STATUS_CODES = AlgoHttpClientWithRetry.RETRY_STATUS_CODES.filter((s) => s !== 504)
  /** The status codes whose `Retry-After` header is honored. */
  private static readonly RETRY_AFTER_STATUS_CODES = [429, 503]
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

  /**
   * How long a failed response asks to wait before retrying, from its `Retry-After` header (seconds or an HTTP date),
   * or undefined without one. Only for 429 and 503. The header name is looked up case-insensitively.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static retryAfterMs(err: any): number | undefined {
    const status = Number(err?.response?.status ?? err?.status)
    if (!AlgoHttpClientWithRetry.RETRY_AFTER_STATUS_CODES.includes(status)) return undefined
    const headers = err?.response?.headers
    if (!headers || typeof headers !== 'object') return undefined
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'retry-after')
    if (key === undefined) return undefined
    const value = String(headers[key]).trim()
    if (/^\d+$/.test(value)) return Number(value) * 1000
    const date = Date.parse(value)
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
  }

  /** The status codes to retry for a request to `relativePath`. */
  private static retryStatusCodes(relativePath: string): number[] {
    return relativePath.replace(/\/+$/, '') === '/v2/query'
      ? AlgoHttpClientWithRetry.QUERY_RETRY_STATUS_CODES
      : AlgoHttpClientWithRetry.RETRY_STATUS_CODES
  }

  private async callWithRetry(
    func: () => Promise<BaseHTTPClientResponse>,
    signal?: AbortSignal,
    retryStatusCodes: number[] = AlgoHttpClientWithRetry.RETRY_STATUS_CODES,
  ): Promise<BaseHTTPClientResponse> {
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
        // Only retry for one of the hardcoded conditions
        if (!(
          AlgoHttpClientWithRetry.RETRY_ERROR_CODES.includes(err.code) ||
          retryStatusCodes.includes(Number(err.status)) ||
          ('response' in err && retryStatusCodes.includes(Number(err.response.status)))
        )) {
          throw err
        }
        // Retry immediately the first time, then exponentially backoff; wait at least as long as a Retry-After header asks
        // (capped at the longest backoff).
        const backoffMs = numTries == 1 ? 0 : Math.min(1000 * Math.pow(2, numTries - 1), AlgoHttpClientWithRetry.MAX_BACKOFF_MS)
        const retryAfterMs = AlgoHttpClientWithRetry.retryAfterMs(err)
        const delayTimeMs =
          retryAfterMs === undefined ? backoffMs : Math.min(Math.max(backoffMs, retryAfterMs), AlgoHttpClientWithRetry.MAX_BACKOFF_MS)
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
      () => super.get(relativePath, query, requestHeaders, customOptions),
      AlgoHttpClientWithRetry.signalOf(customOptions),
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
      () => super.post(relativePath, data, query, requestHeaders, customOptions),
      AlgoHttpClientWithRetry.signalOf(customOptions),
      AlgoHttpClientWithRetry.retryStatusCodes(relativePath),
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
      () => super.delete(relativePath, data, query, requestHeaders, customOptions),
      AlgoHttpClientWithRetry.signalOf(customOptions),
    )
  }
}
