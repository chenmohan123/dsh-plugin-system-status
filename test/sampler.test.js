import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { cpuPercent, createSampler } from '../host/sampler.js'

const cpus = (user, idle) => [{ times: { user, nice: 0, sys: 0, idle, irq: 0, iowait: 0 } }]

test('cpuPercent reports a fully busy core', () => {
  assert.deepEqual(cpuPercent(cpus(0, 100), cpus(100, 100)), { total: 100, perCore: [100] })
})

test('cpuPercent reports an idle core', () => {
  assert.deepEqual(cpuPercent(cpus(0, 100), cpus(0, 200)), { total: 0, perCore: [0] })
})

test('cpuPercent refuses to divide by a counter that did not advance', () => {
  assert.deepEqual(cpuPercent(cpus(5, 5), cpus(5, 5)), { total: 0, perCore: [0] })
})

test('a tick builds a complete sample from the injected sources', async () => {
  const gpu = {
    read: () => ({ util: 4, vramUsed: 2159, vramTotal: 16311, tempC: 47.75, powerW: 16.57 }),
  }
  let volumeCalls = 0
  const sampler = createSampler({
    gpu,
    now: () => 1_700_000_000_000,
    volumes: async () => {
      volumeCalls += 1
      return [{ id: 'C:', total: 1000, free: 250 }]
    },
  })

  const sample = await sampler.tick()

  assert.equal(sample.t, 1_700_000_000_000)
  assert.equal(sample.cpu.perCore.length, os.cpus().length)
  assert.ok(sample.cpu.total >= 0 && sample.cpu.total <= 100)
  assert.equal(sample.mem.total, os.totalmem())
  assert.ok(sample.mem.used >= 0 && sample.mem.used <= sample.mem.total)
  assert.deepEqual(sample.disks, [{ id: 'C:', total: 1000, free: 250 }])
  assert.equal(sample.gpu.util, 4)

  await sampler.tick()
  assert.equal(volumeCalls, 1, 'volumes are cached between ticks')
})

test('a sampler without a GPU still produces samples', async () => {
  const sampler = createSampler({ now: () => 1, volumes: async () => [] })
  const sample = await sampler.tick()
  assert.equal(sample.gpu, null)
  assert.deepEqual(sample.disks, [])
})

test('start publishes ticks to subscribers and stop halts them', async () => {
  const sampler = createSampler({ now: () => Date.now(), intervalMs: 10, volumes: async () => [] })
  const seen = []
  const unsubscribe = sampler.subscribe((sample) => seen.push(sample.t))
  sampler.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  sampler.stop()
  const countAfterStop = seen.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(countAfterStop > 0)
  assert.equal(seen.length, countAfterStop)
  unsubscribe()
  assert.equal(sampler.listenerCount(), 0)
})
