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

describe('AlgoHttpClientWithRetry Retry-After and query time-outs', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const client = () => new AlgoHttpClientWithRetry({}, 'http://localhost', 4001)
  const failing =
    (status: number, headers: Record<string, string> = {}) =>
    () =>
      new Response(JSON.stringify({ message: 'nope' }), { status, headers })

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('a 503 with Retry-After in seconds waits that long before the first retry', async () => {
    fetchMock.mockImplementationOnce(async () => failing(503, { 'Retry-After': '2' })()).mockImplementationOnce(async () => ok())
    const request = client().post('/v2/transactions/simulate', new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await request).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('a 429 with Retry-After as an HTTP date waits until then', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    fetchMock
      .mockImplementationOnce(async () => failing(429, { 'retry-after': 'Thu, 01 Jan 2026 00:00:03 GMT' })())
      .mockImplementationOnce(async () => ok())
    const request = client().get('/v2/status')
    await vi.advanceTimersByTimeAsync(2_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await request).status).toBe(200)
  })

  test('Retry-After is capped at the longest backoff', async () => {
    fetchMock.mockImplementationOnce(async () => failing(503, { 'Retry-After': '3600' })()).mockImplementationOnce(async () => ok())
    const request = client().get('/v2/status')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await request).status).toBe(200)
  })

  test('Retry-After never shortens the backoff', async () => {
    fetchMock
      .mockImplementationOnce(async () => failing(503)())
      .mockImplementationOnce(async () => failing(503, { 'Retry-After': '1' })())
      .mockImplementationOnce(async () => ok())
    const request = client().get('/v2/status')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect((await request).status).toBe(200)
  })

  test('without Retry-After, the first retry is immediate and the second waits 2 s', async () => {
    fetchMock.mockImplementation(async () => failing(503)())
    const request = client().get('/v2/status')
    const settled = request.catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await settled).toMatchObject({ response: { status: 503 } })
  })

  test('a 504 from /v2/query is not retried', async () => {
    fetchMock.mockImplementation(async () => failing(504)())
    await expect(client().post('/v2/query', new Uint8Array([1]))).rejects.toMatchObject({ response: { status: 504 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a 504 from /v2/transactions/simulate is still retried', async () => {
    fetchMock.mockImplementationOnce(async () => failing(504)()).mockImplementationOnce(async () => ok())
    const request = client().post('/v2/transactions/simulate', new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(0)
    expect((await request).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('a 503 from /v2/query is retried after Retry-After', async () => {
    fetchMock.mockImplementationOnce(async () => failing(503, { 'Retry-After': '1' })()).mockImplementationOnce(async () => ok())
    const request = client().post('/v2/query', new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await request).status).toBe(200)
  })

  test('an abort during a Retry-After wait stops it', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => failing(503, { 'Retry-After': '5' })())
    const settled = client()
      .post('/v2/query', new Uint8Array([1]), undefined, {}, { signal: controller.signal })
      .catch((e) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await settled).toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('AlgoHttpClientWithRetry dtalgod 503s and listing time-outs', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const client = () => new AlgoHttpClientWithRetry({}, 'http://localhost', 4001)
  const failing =
    (status: number, message: string, headers: Record<string, string> = {}) =>
    async () =>
      new Response(JSON.stringify({ message }), { status, headers })
  const busy = 'the node is busy: try again later or on another node'

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test.each([
    [
      '/v2/applications/5/boxes/versions',
      'timetravel: the box index is incomplete: build it with ttimport -index-boxes while the node is stopped',
    ],
    [
      '/v2/assets/31566704/holders',
      'timetravel: the asset holders index is not complete: build it with ttimport -holders-index while the node is stopped',
    ],
    ['/v2/accounts/A/versions', 'the time travel history is not served'],
  ])('a 503 for history the node cannot serve is not retried (%s)', async (path, message) => {
    fetchMock.mockImplementation(failing(503, message))
    await expect(client().get(path)).rejects.toMatchObject({ response: { status: 503 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('the history text is also found in a body that the error message leaves out', async () => {
    const c = client()
    // A base client whose errors carry only the status in their message
    vi.spyOn(Object.getPrototypeOf(AlgoHttpClientWithRetry.prototype), 'get').mockImplementation(async () => {
      throw Object.assign(new Error('Received status 503'), {
        response: {
          status: 503,
          headers: {},
          body: new TextEncoder().encode(JSON.stringify({ message: 'the time travel history is not served' })),
        },
      })
    })
    try {
      await expect(c.get('/v2/accounts/A/versions')).rejects.toMatchObject({ response: { status: 503 } })
      expect(Object.getPrototypeOf(AlgoHttpClientWithRetry.prototype).get).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
    }
  })

  test('a busy node without Retry-After gets its first retry after 1 s, then the usual backoff', async () => {
    fetchMock.mockImplementation(failing(503, busy))
    const settled = client()
      .post('/v2/transactions/simulate', new Uint8Array([1]))
      .catch((e) => e)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await settled).toMatchObject({ response: { status: 503 } })
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  test('a node with no slot to re-evaluate an old round counts as busy', async () => {
    fetchMock
      .mockImplementationOnce(failing(503, 'every slot for re-evaluating old rounds is in use'))
      .mockImplementationOnce(async () => ok())
    const request = client().get('/v2/deltas/1000')
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await request).status).toBe(200)
  })

  test('a busy node with Retry-After waits as the header says', async () => {
    fetchMock.mockImplementationOnce(failing(503, busy, { 'Retry-After': '2' })).mockImplementationOnce(async () => ok())
    const request = client().get('/v2/accounts/A')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await request).status).toBe(200)
  })

  test('another 503 keeps the immediate first retry', async () => {
    fetchMock.mockImplementationOnce(failing(503, 'upstream unavailable')).mockImplementationOnce(async () => ok())
    const request = client().get('/v2/status')
    await vi.advanceTimersByTimeAsync(0)
    expect((await request).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test.each(['/v2/assets/1/versions', '/v2/applications/5/box/versions', '/v2/accounts/A/apps/5/versions/', '/v2/assets/1/holders'])(
    'a 504 from GET %s is not retried',
    async (path) => {
      fetchMock.mockImplementation(failing(504, 'time limit exceeded'))
      await expect(client().get(path)).rejects.toMatchObject({ response: { status: 504 } })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  test('a 504 from GET /v2/status is still retried', async () => {
    fetchMock.mockImplementationOnce(failing(504, 'gateway')).mockImplementationOnce(async () => ok())
    const request = client().get('/v2/status')
    await vi.advanceTimersByTimeAsync(0)
    expect((await request).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('a 503 from a versions listing is still retried', async () => {
    fetchMock.mockImplementationOnce(failing(503, 'upstream unavailable')).mockImplementationOnce(async () => ok())
    const request = client().get('/v2/assets/1/versions')
    await vi.advanceTimersByTimeAsync(0)
    expect((await request).status).toBe(200)
  })
})
