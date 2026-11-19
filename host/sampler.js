import os from 'node:os'
import { statfs } from 'node:fs/promises'

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/**
 * Usage percentage between two `os.cpus()` snapshots, per core and overall.
 * A counter that did not advance (or went backwards) contributes 0 instead of
 * dividing by zero.
 * @param {Array<{times: object}>} prevCpus snapshot taken earlier
 * @param {Array<{times: object}>} nextCpus snapshot taken now
 * @returns {{total: number, perCore: number[]}}
 */
export function cpuPercent(prevCpus, nextCpus) {
  const perCore = []
  let totalDelta = 0
  let idleDelta = 0
  const count = Math.min(prevCpus?.length ?? 0, nextCpus?.length ?? 0)
  for (let index = 0; index < count; index += 1) {
    const before = prevCpus[index].times
    const after = nextCpus[index].times
    const beforeIdle = before.idle + (before.iowait ?? 0)
    const afterIdle = after.idle + (after.iowait ?? 0)
    const beforeSum =
      before.user + before.nice + before.sys + before.idle + (before.irq ?? 0) + (before.iowait ?? 0)
    const afterSum =
      after.user + after.nice + after.sys + after.idle + (after.irq ?? 0) + (after.iowait ?? 0)
    const deltaTotal = afterSum - beforeSum
    const deltaIdle = afterIdle - beforeIdle
    totalDelta += deltaTotal
    idleDelta += deltaIdle
    perCore.push(deltaTotal <= 0 ? 0 : Math.round((1000 * (deltaTotal - deltaIdle)) / deltaTotal) / 10)
  }
  const total = totalDelta <= 0 ? 0 : Math.round((1000 * (totalDelta - idleDelta)) / totalDelta) / 10
  return { total, perCore }
}

/**
 * Mounted fixed volumes with total and available bytes, one entry per drive
 * letter that answers `statfs`. Probe cost is why the sampler caches it.
 * @returns {Promise<Array<{id: string, total: number, free: number}>>}
 */
export async function listFixedVolumes() {
  const volumes = []
  for (const letter of DRIVE_LETTERS) {
    try {
      const stats = await statfs(`${letter}:\\`)
      const total = stats.bsize * stats.blocks
      if (!Number.isFinite(total) || total <= 0) continue
      volumes.push({ id: `${letter}:`, total, free: stats.bsize * stats.bavail })
    } catch {
      /* no fixed volume behind this letter */
    }
  }
  return volumes
}

/**
 * Build one status sample: CPU from consecutive snapshots, memory from os,
 * disks from the cached volume list, and whatever the GPU source last read.
 * @param {{gpu?: {read: () => object | null} | null, now?: () => number, intervalMs?: number, volumes?: () => Promise<Array<object>>, volumeRefreshMs?: number}} [options]
 */
export function createSampler({
  gpu = null,
  now = () => Date.now(),
  intervalMs = 1000,
  volumes = listFixedVolumes,
  volumeRefreshMs = 60000,
  gpuStaleMs = 8000,
} = {}) {
  let prevCpus = os.cpus()
  let volumeCache = []
  let volumeAt = -Infinity
  let timer = null
  const listeners = new Set()

  /** @returns {Promise<object>} one sample in the documented shape */
  async function tick() {
    const nextCpus = os.cpus()
    const cpu = cpuPercent(prevCpus, nextCpus)
    prevCpus = nextCpus
    const t = now()
    if (t - volumeAt >= volumeRefreshMs) {
      volumeAt = t
      volumeCache = await volumes().catch(() => volumeCache)
    }
    const memTotal = os.totalmem()
    const gpuSample = gpu === null ? null : gpu.read()
    // A cached GPU reading older than the staleness window is not live data:
    // a crashed nvidia-smi loop must not freeze the bar at a friendly number.
    const gpuIsStale =
      gpuSample !== null && Number.isFinite(gpuSample.at) && t - gpuSample.at > gpuStaleMs
    return {
      t,
      cpu,
      mem: { used: memTotal - os.freemem(), total: memTotal },
      gpu: gpuIsStale ? null : gpuSample,
      disks: volumeCache,
    }
  }

  return {
    tick,
    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        void tick()
          .then((sample) => {
            for (const listener of listeners) {
              try {
                listener(sample)
              } catch {
                /* one bad subscriber must not stop the others */
              }
            }
          })
          .catch(() => {})
      }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    /**
     * @param {(sample: object) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    listenerCount: () => listeners.size,
  }
}
