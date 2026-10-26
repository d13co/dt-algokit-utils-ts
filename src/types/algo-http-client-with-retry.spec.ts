import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AlgoHttpClientWithRetry } from './algo-http-client-with-retry'

// Offline tests of aborting requests through the retrying HTTP client, with a mocked fetch.

const ok = () => new Response(JSON.stringify({ 'last-round': 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
const unavailable = () => new Response(JSON.stringify({ message: 'busy' }), { status: 503 })

describe('AlgoHttpClientWithRetry abort', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const client = () => new AlgoHttpClientWithRetry({}, 'http://localhost', 4001)

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('the signal is passed to fetch', async () => {
    fetchMock.mockImplementation(async () => ok())
    const { signal } = new AbortController()
    await client().get('/v2/status', undefined, {}, { signal })
    await client().post('/v2/transactions/simulate', new Uint8Array([1]), undefined, {}, { signal })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([, init]) => init.signal)).toEqual([signal, signal])
  })

  test('an already aborted signal makes no request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(client().get('/v2/status', undefined, {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('an aborted request is not retried', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => {
      controller.abort()
      throw controller.signal.reason
    })
    await expect(client().get('/v2/status', undefined, {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('an abort during the backoff stops the retries', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => unavailable())
    const request = client().get('/v2/status', undefined, {}, { signal: controller.signal })
    const settled = request.catch((e) => e)
    // The first retry is immediate, the second waits 2 s
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    controller.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await settled).toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('without a signal, failures are still retried', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok())
    const request = client().get('/v2/status')
    await vi.advanceTimersByTimeAsync(0)
    expect((await request).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
