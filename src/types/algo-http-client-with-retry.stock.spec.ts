import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Config } from '../config'
import { AlgoHttpClientWithRetry } from './algo-http-client-with-retry'
import { EventType } from './lifecycle-events'

// The retry client as it runs with stock algosdk (or a dt-algosdk without `retry-policy`): upstream algokit-utils' loop.
vi.mock('./dt-support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dt-support')>()),
  getDTRetry: () => undefined,
}))

const ok = () => new Response(JSON.stringify({ 'last-round': 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
const failing =
  (status: number, headers: Record<string, string> = {}) =>
  async () =>
    new Response(JSON.stringify({ message: 'the node is busy' }), { status, headers })

describe('AlgoHttpClientWithRetry without the dt-algosdk retry policy', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const client = (retry?: ConstructorParameters<typeof AlgoHttpClientWithRetry>[4]) =>
    new AlgoHttpClientWithRetry({}, 'http://localhost', 4001, undefined, retry)

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    vi.spyOn(Config.logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('retries 5 times, at once and then after 2, 4 and 8 s, ignoring Retry-After', async () => {
    fetchMock.mockImplementation(failing(503, { 'Retry-After': '20' }))
    const settled = client()
      .get('/v2/status')
      .catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await settled).toMatchObject({ response: { status: 503 } })
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  test('the retry options and the retry-wait event have no effect', async () => {
    const onWait = vi.fn()
    const listener = vi.fn()
    Config.events.on(EventType.RetryWait, listener)
    try {
      fetchMock.mockImplementationOnce(failing(500)).mockImplementationOnce(async () => ok())
      const request = client({ maxTries: 1, onWait }).get('/v2/status')
      await vi.advanceTimersByTimeAsync(0)
      expect((await request).status).toBe(200)
      expect(onWait).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
    } finally {
      Config.events.off(EventType.RetryWait, listener)
    }
  })

  test('a network error code on the cause (Node fetch) is retried', async () => {
    fetchMock
      .mockImplementationOnce(async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
      })
      .mockImplementationOnce(async () => ok())
    const request = client().get('/v2/status')
    await vi.advanceTimersByTimeAsync(0)
    expect((await request).status).toBe(200)
  })

  test('an abort stops the retries', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(failing(500))
    const settled = client()
      .get('/v2/status', undefined, {}, { signal: controller.signal })
      .catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await settled).toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
