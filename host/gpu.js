import { spawn } from 'node:child_process'

/** Fields requested from nvidia-smi, in the order the CSV line reports them. */
const GPU_FIELDS = [
  'name',
  'memory.used',
  'memory.total',
  'utilization.gpu',
  'temperature.gpu',
  'power.draw',
  'fan.speed',
]

/**
 * Parse one `--format=csv,noheader,nounits` line from nvidia-smi into a GPU
 * sample. Unavailable numeric fields become null; a line without a usable
 * utilization or total VRAM is not a sample.
 * @param {string} line raw CSV line
 * @returns {{util: number, vramUsed: number, vramTotal: number, tempC: number | null, powerW: number | null} | null}
 */
export function parseGpuLine(line) {
  if (typeof line !== 'string') return null
  const parts = line.trim().split(',').map((part) => part.trim())
  if (parts.length < GPU_FIELDS.length) return null
  const number = (text) => {
    const value = Number(text)
    return Number.isFinite(value) ? value : null
  }
  const vramUsed = number(parts[1])
  const vramTotal = number(parts[2])
  const util = number(parts[3])
  if (util === null || vramTotal === null || vramTotal <= 0) return null
  return {
    util,
    vramUsed: vramUsed ?? 0,
    vramTotal,
    tempC: number(parts[4]),
    powerW: number(parts[5]),
  }
}

/**
 * A persistent nvidia-smi sampler. It keeps one `--loop-ms` child alive and
 * caches the newest parsed sample, so a tick costs nothing when the child is
 * healthy and a missing driver only degrades GPU data to null.
 * @param {{command?: string, intervalMs?: number, retryMs?: number}} [options]
 * @returns {{read: () => object | null, stop: () => void}}
 */
export function createGpuSource({
  command = 'nvidia-smi',
  intervalMs = 1000,
  retryMs = 60000,
  spawnImpl = spawn,
} = {}) {
  let latest = null
  let latestAt = 0
  let child = null
  let retryTimer = null
  let stopped = false
  let buffer = ''

  const scheduleRetry = () => {
    if (stopped || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      spawnChild()
    }, retryMs)
    retryTimer.unref?.()
  }

  const spawnChild = () => {
    if (stopped) return
    let started
    try {
      started = spawnImpl(
        command,
        [
          `--query-gpu=${GPU_FIELDS.join(',')}`,
          '--format=csv,noheader,nounits',
          `--loop-ms=${intervalMs}`,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      scheduleRetry()
      return
    }
    child = started
    started.on('error', () => {
      if (child === started) child = null
      scheduleRetry()
    })
    started.on('exit', () => {
      if (child === started) child = null
      scheduleRetry()
    })
    started.stdout?.setEncoding('utf8')
    started.stdout?.on('data', (chunk) => {
      buffer += chunk
      let at = buffer.indexOf('\n')
      while (at !== -1) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        const parsed = parseGpuLine(line)
        if (parsed !== null) {
          latest = parsed
          latestAt = Date.now()
        }
        at = buffer.indexOf('\n')
      }
    })
  }

  spawnChild()

  return {
    read: () => (latest === null ? null : { ...latest, at: latestAt }),
    stop() {
      stopped = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (child !== null) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        child = null
      }
    },
  }
}
