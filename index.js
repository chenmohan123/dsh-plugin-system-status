import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGpuSource } from './host/gpu.js'
import { createSampler } from './host/sampler.js'
import { createHistoryStore } from './host/history.js'
import { registerRoutes } from './host/routes.js'

const SAMPLE_INTERVAL_MS = 3000
const HISTORY_FLUSH_MS = 5000
const HISTORY_RETENTION_DAYS = 7

/** The routes live on the host web server, so require it instead of degrading. */
export const inject = ['webServer']

/**
 * Start sampling, persist history, and publish both over HTTP. Everything this
 * opens is registered on the plugin's own context, so disabling the plugin
 * releases the timer, the nvidia-smi child, the routes, and every open stream.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 */
export function apply(ctx) {
  const gpu = createGpuSource({ intervalMs: SAMPLE_INTERVAL_MS })
  const sampler = createSampler({ gpu, intervalMs: SAMPLE_INTERVAL_MS })
  const historyDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'system-status')
  const history = createHistoryStore({
    dir: historyDir,
    retentionDays: HISTORY_RETENTION_DAYS,
    flushMs: HISTORY_FLUSH_MS,
  })

  ctx.effect(() => {
    const releaseRoutes = registerRoutes(ctx.webServer, { sampler, history })
    const unsubscribe = sampler.subscribe((sample) => history.push(sample))
    sampler.start()
    return () => {
      unsubscribe()
      releaseRoutes()
      sampler.stop()
      gpu.stop()
      void history.close().catch(() => {})
    }
  })
}
