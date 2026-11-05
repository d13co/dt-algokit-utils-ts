// The retry policy's types, as dt-algosdk declares them (`RetryPolicy`, `RetryWait`, ...). Declared here so that
// algokit-utils' types never name dt-algosdk's, which stock algosdk doesn't have. See "Retries" in docs/dt-fork.md.

/** Why a failed request is retried. */
export type RetryWaitReason = 'rate-limited' | 'node-busy' | 'server-error' | 'network'

/** Why a failed request is retried, or why it is not. */
export type RetryReason =
  | RetryWaitReason
  | 'aborted'
  | 'not-retryable'
  | 'history-unavailable'
  | 'time-limit'
  | 'not-idempotent'
  | 'max-tries'
  | 'retry-after-too-long'

/** A request that failed, after `tries` tries (the failed one included). */
export interface RetryContextLike {
  method: 'get' | 'post' | 'delete'
  /** The path without the query, e.g. `/v2/query`. */
  path: string
  /** The request's abort signal: an aborted request is never retried. */
  signal?: AbortSignal
  tries: number
}

/** Whether to retry a failed request, why, and how long to wait first. */
export type RetryDecisionLike =
  | {
      retry: true
      reason: RetryWaitReason
      delayMs: number
      /** The node's `Retry-After`, in milliseconds, when it sent one. */
      retryAfterMs?: number
    }
  | { retry: false; reason: RetryReason; retryAfterMs?: number }

/** A request about to wait before it is retried. */
export interface RetryWaitLike {
  reason: RetryWaitReason
  /** How long it waits, in milliseconds; 0 retries at once. */
  delayMs: number
  /** When the retry starts, in epoch milliseconds. */
  until: number
  /** The node's `Retry-After`, in milliseconds, when it sent one. */
  retryAfterMs?: number
  /** Which retry this is, from 1. */
  retry: number
  /** The most retries the request makes (`maxTries - 1`). */
  maxRetries: number
  method: 'get' | 'post' | 'delete'
  path: string
  /** The HTTP status, unless the request got no response. */
  status?: number
  /** The error the failed try threw. */
  error: unknown
}

/** How failed requests are retried; every field has a default. */
export interface RetryPolicyLike {
  /** Tries in all, the first included; 1 turns retries off. Default 5. Not even `decide` retries past it. */
  maxTries: number
  /** The longest backoff, in milliseconds. Default 10 000. */
  maxBackoffMs: number
  /** The longest `Retry-After` honoured, in milliseconds; a longer one gives up at once. Default 30 000. */
  maxRetryAfterMs: number
  /**
   * The least wait, in milliseconds, before retrying a 429 or a busy 503 with no `Retry-After` (or `Retry-After: 0`), a
   * refused connection (`ECONNREFUSED`), or a browser's failed fetch. Default 1000.
   */
  busyMinDelayMs: number
  /** The backoff before retry `retry` (from 1), in milliseconds, before `maxBackoffMs` caps it. Default 0, then 2, 4, 8 s. */
  backoffMs: (retry: number) => number
  /** The HTTP statuses that may be retried (default 408, 429, 500, 502, 503, 504). Replaces the default list. */
  retryStatuses: readonly number[]
  /** The network error codes that may be retried. Replaces the default list. */
  networkCodes: readonly string[]
  /** Overrides any decision: gets the error, the request and the policy's own decision; returns the one to follow, within `maxTries`. */
  decide?: (err: unknown, ctx: RetryContextLike, defaultDecision: RetryDecisionLike) => RetryDecisionLike
  /** Called before every retry, those with no wait included. An exception it throws, or a promise it rejects, is ignored. */
  onWait?: (wait: RetryWaitLike) => void
  /** How to wait. Default: a timer that an abort of `signal` ends early. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The retry policy fields to change (left out or undefined: the default; lists replace the defaults), or `false` for no retries. */
export type RetryOptionsLike = Partial<RetryPolicyLike> | false
