import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createGpuSource, parseGpuLine } from '../host/gpu.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0)
  }
  return child
}

test('parses a full nvidia-smi csv line', () => {
  assert.deepEqual(parseGpuLine('NVIDIA GeForce RTX 5060 Ti, 2159, 16311, 4, 47.75, 16.57, 0'), {
    util: 4,
    vramUsed: 2159,
    vramTotal: 16311,
    tempC: 47.75,
    powerW: 16.57,
  })
})

test('rejects an empty, short, or non-string line', () => {
  assert.equal(parseGpuLine(''), null)
  assert.equal(parseGpuLine('a, b, c'), null)
  assert.equal(parseGpuLine(undefined), null)
})

test('tolerates unavailable fields', () => {
  assert.deepEqual(parseGpuLine('GPU, [N/A], 16311, 4, [N/A], [N/A], [N/A]'), {
    util: 4,
    vramUsed: 0,
    vramTotal: 16311,
    tempC: null,
    powerW: null,
  })
})

test('rejects a line without utilization or total vram', () => {
  assert.equal(parseGpuLine('GPU, 100, [N/A], 4, 40, 10, 0'), null)
  assert.equal(parseGpuLine('GPU, 100, 16311, [N/A], 40, 10, 0'), null)
})

test('the gpu source caches the newest complete line from the loop child', () => {
  const child = fakeChild()
  const calls = []
  const source = createGpuSource({
    spawnImpl: (...args) => {
      calls.push(args)
      return child
    },
  })

  assert.equal(calls.length, 1)
  assert.ok(calls[0][1].includes('--loop-ms=1000'))
  assert.equal(source.read(), null)

  child.stdout.emit('data', 'GPU, 100, 1000, 4, 40, 10, 0\n')
  const first = source.read()
  assert.deepEqual(
    { util: first.util, vramUsed: first.vramUsed, vramTotal: first.vramTotal, tempC: first.tempC, powerW: first.powerW },
    { util: 4, vramUsed: 100, vramTotal: 1000, tempC: 40, powerW: 10 },
  )
  assert.ok(Number.isFinite(first.at), 'the reading carries the moment it was parsed')

  child.stdout.emit('data', 'GPU, 200, 1000, 9, 41, 11, 0\nGPU, 2')
  assert.equal(source.read().vramUsed, 200, 'a partial line waits for its newline')

  child.stdout.emit('data', '50, 1000, 12, 42, 12, 0\n')
  assert.equal(source.read().vramUsed, 250)

  source.stop()
  assert.equal(child.killed, true)
})

test('a dead child is retried, and never after stop', async () => {
  const children = []
  const source = createGpuSource({
    retryMs: 5,
    spawnImpl: () => {
      const child = fakeChild()
      children.push(child)
      return child
    },
  })

  assert.equal(children.length, 1)
  children[0].emit('exit', 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(children.length, 2, 'a missing driver is retried')

  source.stop()
  children[1].emit('exit', 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(children.length, 2, 'stop ends the retry loop')
})
