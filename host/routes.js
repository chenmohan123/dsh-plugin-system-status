export const STREAM_PATH = '/dsh-system-status/stream'
export const HISTORY_PATH = '/dsh-system-status/history'

/**
 * Serve the live sample stream (SSE) and the windowed history JSON on two
 * same-origin routes. The returned disposer removes both routes, unsubscribes
 * from the sampler, and ends every open stream so a disabled plugin leaves no
 * half-open connection behind.
 * @param {{register: (route: object) => () => void}} webServer host web server service
 * @param {{sampler: {subscribe: (fn: (sample: object) => void) => () => void}, history: {read: (range: string) => Promise<object>}}} sources
 * @returns {() => void} disposer
 */
export function registerRoutes(webServer, { sampler, history }) {
  const clients = new Set()

  const unsubscribe = sampler.subscribe((sample) => {
    const frame = `data: ${JSON.stringify(sample)}\n\n`
    for (const client of clients) {
      try {
        client.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  })

  const releaseStream = webServer.register({
    kind: 'exact',
    path: STREAM_PATH,
    handler(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      clients.add(res)
      req.on?.('close', () => {
        clients.delete(res)
      })
    },
  })

  const releaseHistory = webServer.register({
    kind: 'exact',
    path: HISTORY_PATH,
    async handler(req, res) {
      let range = '1h'
      try {
        range = new URL(req.url ?? '/', 'http://local').searchParams.get('range') ?? '1h'
      } catch {
        /* keep the default window */
      }
      let payload
      try {
        payload = await history.read(range)
      } catch {
        // A read failure is not an empty history: say so with a status the page
        // can distinguish from "nothing recorded".
        const body = JSON.stringify({ error: 'read-failed', points: [] })
        res.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
        return
      }
      const body = JSON.stringify(payload)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    },
  })

  return () => {
    unsubscribe()
    releaseStream()
    releaseHistory()
    for (const client of clients) {
      try {
        client.end()
      } catch {
        /* already closed by the peer */
      }
    }
    clients.clear()
  }
}
