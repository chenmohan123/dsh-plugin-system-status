import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregate, createHistoryStore, downsample, parseLines } from '../host/history.js'

const sampleAt = (t, overrides = {}) => ({
  t,
  cpu: { total: 10, perCore: [] },
  mem: { used: 100, total: 200 },
  gpu: null,
  disks: [{ id: 'C:', total: 1000, free: 500 }],
  ...overrides,
})

test('parseLines skips malformed and schema-incompatible lines', () => {
  const text = [
    JSON.stringify(sampleAt(1)),
    'not json',
    '',
    JSON.stringify({ t: 2 }),
    JSON.stringify(sampleAt(3)),
  ].join('\n')
  assert.deepEqual(
    parseLines(text).map((sample) => sample.t),
    [1, 3],
  )
})

test('downsample caps the point count and keeps both ends', () => {
  const samples = Array.from({ length: 1000 }, (_, index) => sampleAt(index))
  const result = downsample(samples, 300)
  assert.equal(result.length, 300)
  assert.equal(result[0].t, 0)
  assert.equal(result[299].t, 999)
  assert.equal(downsample(samples.slice(0, 10), 300).length, 10)
})

test('aggregate averages inside a bucket and leaves empty buckets out', () => {
  const result = aggregate([sampleAt(1000), sampleAt(1500), sampleAt(5000)], 2000)
  assert.equal(result.length, 2)
  assert.equal(result[0].t, 0)
  assert.equal(result[0].cpu.total, 10)
  assert.equal(result[1].t, 4000)
})

test('the store appends, reads a window, and survives a torn line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-status-'))
  const now = () => 1_700_000_000_000
  const store = createHistoryStore({ dir, flushMs: 60000, now })
  store.push(sampleAt(now() - 5000))
  store.push(sampleAt(now() - 1000))
  await store.flush()

  const dayFile = (await readdir(dir)).find((name) => name.endsWith('.jsonl'))
  const text = await readFile(join(dir, dayFile), 'utf8')
  assert.equal(text.trim().split('\n').length, 2)

  await writeFile(join(dir, dayFile), text + 'torn-line\n', 'utf8')
  const window = await store.read('1h')
  assert.equal(window.disabled, false)
  assert.ok(window.points.length >= 1)
  assert.ok(window.points.every((point) => point.t <= now() && point.t >= now() - 3600 * 1000))
  await store.close()
})

test('prune removes files older than the retention window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-status-'))
  const now = () => 1_700_000_000_000
  const old = new Date(now() - 9 * 24 * 3600 * 1000)
  const name = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(
    old.getDate(),
  ).padStart(2, '0')}.jsonl`
  await writeFile(join(dir, name), '', 'utf8')

  const store = createHistoryStore({ dir, retentionDays: 7, now })
  await store.prune()
  assert.deepEqual(await readdir(dir), [])
  await store.close()
})

test('an unwritable directory disables persistence instead of throwing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-status-'))
  const blocker = join(base, 'not-a-directory')
  await writeFile(blocker, 'x', 'utf8')
  const store = createHistoryStore({ dir: join(blocker, 'nested'), now: () => Date.now(), flushMs: 60000 })
  store.push(sampleAt(Date.now()))
  await store.flush()
  assert.equal(store.disabled, true)
  const result = await store.read('1h')
  assert.equal(result.disabled, true)
  assert.deepEqual(result.points, [])
  await store.close()
})

test('read reports the window and bucket it covered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-status-'))
  const now = () => 1_700_000_000_000
  const store = createHistoryStore({ dir, now, flushMs: 60000 })
  store.push(sampleAt(now() - 1000))
  await store.flush()

  const result = await store.read('24h')
  assert.equal(result.until, now())
  assert.equal(result.from, now() - 24 * 3600 * 1000)
  assert.equal(result.bucketMs, Math.ceil((24 * 3600 * 1000) / 300))
  assert.equal(result.disabled, false)
  assert.equal(result.lastWriteAt, now())
  await store.close()
})

test('a history directory that does not exist yet is empty, not unreadable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-status-'))
  const store = createHistoryStore({ dir: join(base, 'never-created'), now: () => Date.now(), flushMs: 60000 })
  const result = await store.read('1h')
  assert.deepEqual(result.points, [])
  assert.equal(result.reason, undefined)
  assert.equal(result.disabled, false)
  await store.close()
})

test('gpu fields are averaged only over the samples that carry them', () => {
  const withTemp = sampleAt(1000, {
    gpu: { util: 10, vramUsed: 100, vramTotal: 1000, tempC: 40, powerW: 20 },
  })
  const withoutTemp = sampleAt(1500, {
    gpu: { util: 20, vramUsed: 200, vramTotal: 1000, tempC: null, powerW: null },
  })
  const [bucket] = aggregate([withTemp, withoutTemp], 10000)
  assert.equal(bucket.gpu.util, 15)
  assert.equal(bucket.gpu.tempC, 40, 'a missing reading does not average in as zero')
  assert.equal(bucket.gpu.powerW, 20)
})
