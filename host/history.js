import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const DAY_MS = 24 * 3600 * 1000
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/

/** Supported history windows, in milliseconds. */
export const RANGE_MS = {
  '1h': 3600 * 1000,
  '6h': 6 * 3600 * 1000,
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
}

/**
 * Parse stored JSONL text into samples, skipping torn, malformed, or
 * schema-incompatible lines instead of failing the whole read.
 * @param {string} text file contents
 * @returns {Array<object>} usable samples in file order
 */
export function parseLines(text) {
  const samples = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object') continue
    if (typeof value.t !== 'number') continue
    if (typeof value.cpu?.total !== 'number') continue
    if (typeof value.mem?.total !== 'number') continue
    samples.push(value)
  }
  return samples
}

/**
 * Uniformly thin a series down to at most `maxPoints`, keeping first and last
 * because a chart's edges carry the window bounds.
 * @param {Array<object>} samples
 * @param {number} maxPoints
 * @returns {Array<object>}
 */
export function downsample(samples, maxPoints = 300) {
  if (samples.length <= maxPoints) return samples
  const step = (samples.length - 1) / (maxPoints - 1)
  const result = []
  for (let index = 0; index < maxPoints; index += 1) {
    result.push(samples[Math.round(index * step)])
  }
  return result
}

const round1 = (value) => Math.round(value * 10) / 10

/**
 * Average samples into fixed time buckets. A bucket with no sample is simply
 * absent from the result, so the chart can draw the gap instead of a line
 * across hours when DSH was not running.
 * @param {Array<object>} samples
 * @param {number} bucketMs
 * @returns {Array<object>} bucketed samples, ascending
 */
export function aggregate(samples, bucketMs) {
  const buckets = new Map()
  const field = () => ({ count: 0, sum: 0 })
  const add = (target, value) => {
    if (!Number.isFinite(value)) return
    target.count += 1
    target.sum += value
  }
  const mean = (target) => (target.count === 0 ? null : target.sum / target.count)
  const ensure = (key) => {
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = {
        count: 0,
        cpuTotal: 0,
        memUsed: 0,
        memTotal: 0,
        gpu: { util: field(), vramUsed: field(), vramTotal: field(), tempC: field(), powerW: field() },
        disks: new Map(),
      }
      buckets.set(key, bucket)
    }
    return bucket
  }
  for (const sample of samples) {
    const bucket = ensure(Math.floor(sample.t / bucketMs))
    bucket.count += 1
    bucket.cpuTotal += sample.cpu?.total ?? 0
    bucket.memUsed += sample.mem?.used ?? 0
    bucket.memTotal += sample.mem?.total ?? 0
    if (sample.gpu) {
      add(bucket.gpu.util, sample.gpu.util)
      add(bucket.gpu.vramUsed, sample.gpu.vramUsed)
      add(bucket.gpu.vramTotal, sample.gpu.vramTotal)
      add(bucket.gpu.tempC, sample.gpu.tempC)
      add(bucket.gpu.powerW, sample.gpu.powerW)
    }
    for (const disk of sample.disks ?? []) {
      const accumulator = bucket.disks.get(disk.id) ?? { count: 0, total: 0, free: 0 }
      accumulator.count += 1
      accumulator.total += disk.total
      accumulator.free += disk.free
      bucket.disks.set(disk.id, accumulator)
    }
  }
  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([key, bucket]) => {
      const gpu = {
        util: mean(bucket.gpu.util),
        vramUsed: mean(bucket.gpu.vramUsed),
        vramTotal: mean(bucket.gpu.vramTotal),
        tempC: mean(bucket.gpu.tempC),
        powerW: mean(bucket.gpu.powerW),
      }
      const hasGpu = gpu.util !== null || gpu.vramUsed !== null || gpu.vramTotal !== null
      return {
        t: key * bucketMs,
        cpu: { total: round1(bucket.cpuTotal / bucket.count), perCore: [] },
        mem: {
          used: Math.round(bucket.memUsed / bucket.count),
          total: Math.round(bucket.memTotal / bucket.count),
        },
        gpu: hasGpu
          ? {
              util: gpu.util === null ? null : round1(gpu.util),
              vramUsed: gpu.vramUsed === null ? null : Math.round(gpu.vramUsed),
              vramTotal: gpu.vramTotal === null ? null : Math.round(gpu.vramTotal),
              tempC: gpu.tempC === null ? null : round1(gpu.tempC),
              powerW: gpu.powerW === null ? null : round1(gpu.powerW),
            }
          : null,
        disks: [...bucket.disks.entries()].map(([id, accumulator]) => ({
          id,
          total: Math.round(accumulator.total / accumulator.count),
          free: Math.round(accumulator.free / accumulator.count),
        })),
      }
    })
}

const dayKey = (t) => {
  const date = new Date(t)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

/**
 * Append-only per-day JSONL history under `dir`, with retention pruning and
 * windowed reads. A directory it cannot create or write disables persistence
 * (`disabled`) instead of throwing, so the live status keeps working.
 * @param {{dir: string, retentionDays?: number, flushMs?: number, maxPoints?: number, now?: () => number, rangeMs?: Record<string, number>}} options
 */
export function createHistoryStore({
  dir,
  retentionDays = 7,
  flushMs = 5000,
  maxPoints = 300,
  now = () => Date.now(),
  rangeMs = RANGE_MS,
} = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('history: dir is required')
  let buffer = []
  let disabled = false
  let closed = false
  let flushTimer = null
  let pendingFlush = Promise.resolve()
  let lastWriteAt = null

  const fileFor = (t) => join(dir, `${dayKey(t)}.jsonl`)

  async function flush() {
    if (disabled || buffer.length === 0) return
    const pending = buffer
    buffer = []
    const payload = pending.map((sample) => JSON.stringify(sample)).join('\n') + '\n'
    const target = fileFor(pending[pending.length - 1].t)
    pendingFlush = pendingFlush.then(async () => {
      try {
        await mkdir(dir, { recursive: true })
        await appendFile(target, payload, 'utf8')
        lastWriteAt = now()
      } catch {
        disabled = true
      }
    })
    await pendingFlush
  }

  async function prune() {
    try {
      const cutoff = now() - retentionDays * DAY_MS
      for (const name of await readdir(dir)) {
        const match = FILE_RE.exec(name)
        if (match === null) continue
        const dayStart = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
        if (dayStart < cutoff) await unlink(join(dir, name)).catch(() => {})
      }
    } catch {
      /* nothing stored yet */
    }
  }

  async function read(range = '1h') {
    const windowMs = rangeMs[range] ?? rangeMs['1h']
    const until = now()
    const from = until - windowMs
    const bucketMs = Math.max(1000, Math.ceil(windowMs / maxPoints))
    const empty = (reason) => ({ points: [], from, until, bucketMs, disabled, reason, lastWriteAt })
    let names = []
    try {
      names = await readdir(dir)
    } catch (error) {
      // A directory that does not exist yet is empty, not broken; anything else
      // is a read failure the page must not present as "no data recorded".
      if (error?.code === 'ENOENT') return empty(undefined)
      return empty('unreadable')
    }
    const samples = []
    for (const name of names) {
      const match = FILE_RE.exec(name)
      if (match === null) continue
      const dayStart = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
      if (dayStart + DAY_MS < from) continue
      try {
        const text = await readFile(join(dir, name), 'utf8')
        for (const sample of parseLines(text)) {
          if (sample.t >= from && sample.t <= until) samples.push(sample)
        }
      } catch {
        /* unreadable file only loses its own samples */
      }
    }
    samples.sort((left, right) => left.t - right.t)
    return {
      points: downsample(aggregate(samples, bucketMs), maxPoints),
      from,
      until,
      bucketMs,
      disabled,
      reason: disabled ? 'unwritable' : undefined,
      lastWriteAt,
    }
  }

  async function close() {
    closed = true
    if (flushTimer !== null) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    await flush()
  }

  flushTimer = setInterval(() => {
    void flush()
  }, flushMs)
  flushTimer.unref?.()
  void prune()

  return {
    /**
     * @param {object} sample one sample in the documented shape
     */
    push(sample) {
      if (disabled || closed) return
      buffer.push(sample)
      if (buffer.length >= 12) void flush()
    },
    flush,
    read,
    prune,
    close,
    get disabled() {
      return disabled
    },
    get lastWriteAt() {
      return lastWriteAt
    },
    buffered: () => buffer.length,
  }
}
