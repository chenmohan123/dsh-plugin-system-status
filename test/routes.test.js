import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerRoutes } from '../host/routes.js'

function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      routes.set(route.path, route)
      return () => {
        routes.delete(route.path)
      }
    },
  }
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(chunk) {
      this.chunks.push(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(chunk)
      this.ended = true
    },
  }
}

function fakeSampler() {
  const listeners = new Set()
  return {
    listeners,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(sample) {
      for (const listener of listeners) listener(sample)
    },
  }
}

test('the stream route writes SSE frames and drops closed clients', () => {
  const sampler = fakeSampler()
  const server = fakeWebServer()
  const dispose = registerRoutes(server, { sampler, history: { read: async () => ({ points: [] }) } })

  const req = new EventEmitter()
  const res = fakeResponse()
  server.routes.get('/dsh-system-status/stream').handler(req, res)

  assert.match(res.headers['content-type'], /text\/event-stream/)
  sampler.emit({ t: 1, cpu: { total: 5 } })
  const streamed = res.chunks.join('')
  assert.ok(streamed.includes('data: {"t":1,"cpu":{"total":5}}\n\n'))

  req.emit('close')
  sampler.emit({ t: 2 })
  assert.equal(res.chunks.join(''), streamed)

  dispose()
  assert.equal(server.routes.size, 0)
  assert.equal(sampler.listeners.size, 0)
})

test('the history route answers JSON for the requested range', async () => {
  let requested = null
  const server = fakeWebServer()
  registerRoutes(server, {
    sampler: fakeSampler(),
    history: {
      read: async (range) => {
        requested = range
        return { points: [], disabled: false }
      },
    },
  })

  const res = fakeResponse()
  await server.routes.get('/dsh-system-status/history').handler(
    { url: '/dsh-system-status/history?range=6h' },
    res,
  )

  assert.equal(requested, '6h')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(res.chunks.join('')), { points: [], disabled: false })
})

test('a history read that throws answers 500 instead of pretending to be empty', async () => {
  const server = fakeWebServer()
  registerRoutes(server, {
    sampler: fakeSampler(),
    history: {
      read: async () => {
        throw new Error('boom')
      },
    },
  })

  const res = fakeResponse()
  await server.routes.get('/dsh-system-status/history').handler({ url: '/dsh-system-status/history' }, res)

  assert.equal(res.status, 500)
  assert.equal(JSON.parse(res.chunks.join('')).error, 'read-failed')
})

test('the disposer ends every open stream', () => {
  const sampler = fakeSampler()
  const server = fakeWebServer()
  const dispose = registerRoutes(server, { sampler, history: { read: async () => ({ points: [] }) } })

  const res = fakeResponse()
  server.routes.get('/dsh-system-status/stream').handler(new EventEmitter(), res)
  dispose()
  assert.equal(res.ended, true)
})
