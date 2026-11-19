window.__ModuleLoader__.load({
  id: 'dsh-plugin-system-status',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'system-status'
    const STREAM_URL = '/dsh-system-status/stream'
    const HISTORY_URL = '/dsh-system-status/history'
    const RANGES = ['1h', '6h', '24h', '7d']
    const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 }
    const STALE_AFTER_MS = 8000

    const DICT = {
      zh: {
        panelTitle: '系统状态',
        barLabel: '系统状态',
        openHistory: '查看历史曲线',
        history: '历史',
        cpu: 'CPU',
        mem: '内存',
        gpu: 'GPU',
        vram: '显存',
        temp: '温度',
        unavailable: '不可用',
        gpuUnavailable: '未检测到 NVIDIA 显卡（当前仅支持 NVIDIA）',
        connecting: '连接中',
        reconnecting: '重连中',
        stale: '数据已过期',
        failed: '实时连接失败',
        historyTitle: '系统状态历史',
        range1h: '近 1 小时',
        range6h: '近 6 小时',
        range24h: '近 24 小时',
        range7d: '近 7 天',
        rangeGroup: '时间范围',
        loading: '加载中…',
        empty: '这段时间没有记录。',
        loadFailed: '读取历史失败',
        retry: '重试',
        refresh: '刷新',
        disabledStorage: '历史目录不可写，只保留实时数据。',
        unreadableStorage: '历史目录读取失败。',
        runtimeOnly: '仅在 DSH 运行时记录；DSH 关闭期间没有数据。',
        window: '窗口',
        covered: '数据覆盖',
        lastSample: '最后采样',
        cpuTitle: 'CPU 使用率',
        gpuTitle: 'GPU 使用率',
        memory: '内存使用率',
        vramTitle: '显存使用率',
        temperature: 'GPU 温度',
        disks: '磁盘已用空间',
        usedPercent: '已用',
        free: '剩余',
        total: '总量',
        hoverHint: '在图上移动查看具体数值',
        latest: '最新',
        singlePoint: '数据还不够画出曲线，DSH 再运行一会儿就有趋势了。',
      },
      en: {
        panelTitle: 'System status',
        barLabel: 'System status',
        openHistory: 'Open history charts',
        history: 'History',
        cpu: 'CPU',
        mem: 'Memory',
        gpu: 'GPU',
        vram: 'VRAM',
        temp: 'Temp',
        unavailable: 'unavailable',
        gpuUnavailable: 'No NVIDIA GPU detected (NVIDIA only for now)',
        connecting: 'Connecting',
        reconnecting: 'Reconnecting',
        stale: 'Stale',
        failed: 'Live connection failed',
        historyTitle: 'System status history',
        range1h: 'Last hour',
        range6h: 'Last 6 hours',
        range24h: 'Last 24 hours',
        range7d: 'Last 7 days',
        rangeGroup: 'Time range',
        loading: 'Loading…',
        empty: 'Nothing recorded in this window.',
        loadFailed: 'Could not read history',
        retry: 'Retry',
        refresh: 'Refresh',
        disabledStorage: 'The history directory is not writable, so only live data remains.',
        unreadableStorage: 'The history directory could not be read.',
        runtimeOnly: 'Recorded only while DSH runs; nothing is captured while it is closed.',
        window: 'Window',
        covered: 'Covered',
        lastSample: 'Last sample',
        cpuTitle: 'CPU utilization',
        gpuTitle: 'GPU utilization',
        memory: 'Memory in use',
        vramTitle: 'VRAM in use',
        temperature: 'GPU temperature',
        disks: 'Disk usage',
        usedPercent: 'used',
        free: 'free',
        total: 'total',
        hoverHint: 'Move over a chart to read values',
        latest: 'Latest',
        singlePoint: 'Not enough samples for a curve yet; trend appears after DSH runs a little longer.',
      },
    }

    /** Localized text through the Client locale service, with an inline fallback. */
    function createTranslator(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : null
      const disposers = []
      let translate = null
      if (locale) {
        try {
          for (const [id, dict] of Object.entries(DICT)) {
            const dispose = locale.register(NS, id, dict)
            if (typeof dispose === 'function') disposers.push(dispose)
          }
        } catch {
          /* the inline dictionaries below still work */
        }
        try {
          translate = locale.bind(NS)
        } catch {
          translate = null
        }
      }
      const activeLanguage = () => {
        try {
          const active = locale?.getLocale?.().active
          if (typeof active === 'string' && active !== '') return active
        } catch {
          /* fall through to the browser language */
        }
        try {
          if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
            return navigator.language
          }
        } catch {
          /* fall through to English */
        }
        return 'en'
      }
      const isChinese = () => activeLanguage().toLowerCase().startsWith('zh')
      return {
        disposers,
        t(key) {
          // Both inline dictionaries are complete, so the active language decides
          // directly and a missing locale service only degrades to the browser
          // language instead of silently forcing English.
          const primary = isChinese() ? DICT.zh : DICT.en
          const secondary = isChinese() ? DICT.en : DICT.zh
          if (typeof primary[key] === 'string') return primary[key]
          if (typeof secondary[key] === 'string') return secondary[key]
          if (translate !== null) {
            try {
              const value = translate(key)
              if (typeof value === 'string' && value !== '' && value !== key) return value
            } catch {
              /* fall through to the key */
            }
          }
          return key
        },
        subscribe: typeof locale?.subscribe === 'function' ? (fn) => locale.subscribe(fn) : null,
      }
    }

    function useLocaleRevision(translator) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        if (translator.subscribe === null) return undefined
        return translator.subscribe(() => force((value) => value + 1))
      }, [translator])
    }

    const formatPercent = (value) => (Number.isFinite(value) ? `${Math.round(value)}%` : '—')
    const formatGiB = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1024 ** 3).toFixed(1)}G` : '—')
    // nvidia-smi reports VRAM in MiB, not bytes.
    const formatVram = (mib) => (Number.isFinite(mib) ? `${(mib / 1024).toFixed(1)}G` : '—')
    const formatTemp = (value) => (Number.isFinite(value) ? `${Math.round(value)}°C` : '—')
    const pad = (value) => String(value).padStart(2, '0')
    const formatClock = (t) => {
      if (!Number.isFinite(t)) return ''
      const date = new Date(t)
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const formatClockSeconds = (t) => {
      if (!Number.isFinite(t)) return ''
      const date = new Date(t)
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }
    const formatStamp = (t) => {
      if (!Number.isFinite(t)) return ''
      const date = new Date(t)
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClockSeconds(t)}`
    }

    const CSS = `
.dss-dock{position:relative;display:flex;align-items:center;min-width:0;max-width:100%;flex:1 1 auto;font-family:inherit}
.dss-dock__hit{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;border-radius:6px;cursor:pointer;text-align:left}
.dss-dock__hit:hover{background:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dss-dock__hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dss-dock__dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-success-primary)}
.dss-dock__dot[data-status="connecting"],.dss-dock__dot[data-status="reconnecting"]{background:var(--dsw-alias-state-warn-primary)}
.dss-dock__dot[data-status="stale"]{background:var(--dsw-alias-state-warn-primary)}
.dss-dock__dot[data-status="failed"]{background:var(--dsw-alias-state-error-primary)}
.dss-dock__readout{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.dss-dock__readout b{font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dss-dock__sep{opacity:.5;padding:0 2px}
.dss-dock__status{color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dss-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dss-page{height:100%;overflow:auto;box-sizing:border-box;padding:28px 24px 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.dss-page__inner{max-width:960px;margin:0 auto}
.dss-page__head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.dss-page__titles{min-width:0}
.dss-page__title{margin:0;font-size:20px;font-weight:500;line-height:28px;outline:none}
.dss-page__sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dss-page__ranges{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.dss-range{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 12px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.dss-range:hover{color:var(--dsw-alias-label-primary)}
.dss-range[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dss-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dss-notice{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px;margin-bottom:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dss-notice--error{border-left-color:var(--dsw-alias-state-error-primary)}
.dss-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;margin-bottom:16px}
.dss-card__head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.dss-card__title{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dss-card__latest{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dss-card__legend{display:flex;gap:12px;margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dss-legend__swatch{display:inline-block;width:10px;height:2px;margin-right:5px;vertical-align:middle}
.dss-chart{display:block;width:100%;height:auto}
.dss-chart__grid{stroke:var(--dsw-alias-border-l2);stroke-width:0.5}
.dss-chart__axis{fill:var(--dsw-alias-label-secondary);font-size:10px}
.dss-chart__hoverline{stroke:var(--dsw-alias-label-secondary);stroke-width:0.5;opacity:.7}
.dss-chart__axisrow{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dss-chart__hoverinfo{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dss-empty{padding:18px 0;text-align:center;color:var(--dsw-alias-label-secondary)}
.dss-error{color:var(--dsw-alias-state-error-primary)}
.dss-retry{margin-left:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:2px 10px;font:inherit;font-size:11px;cursor:pointer}
.dss-foot{margin-top:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dss-disk{display:grid;grid-template-columns:44px 1fr auto;align-items:center;gap:10px;margin-top:10px;font-size:12px}
.dss-disk__track{height:6px;border-radius:3px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dss-disk__fill{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.dss-disk__value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dss-linkbtn{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0 4px;margin-left:auto}
.dss-linkbtn:hover{text-decoration:underline}
`

    const StyleTag = () => h('style', { key: 'dss-style' }, CSS)

    /** Live sample stream with staleness detection and exponential-backoff reconnection. */
    function useLiveSample() {
      const [state, setState] = React.useState({ sample: null, status: 'connecting', lastFrameAt: 0 })
      React.useEffect(() => {
        let source = null
        let retryTimer = null
        let retryMs = 1000
        let failures = 0
        let disposed = false

        const schedule = () => {
          if (disposed) return
          if (retryTimer !== null) clearTimeout(retryTimer)
          retryTimer = setTimeout(connect, retryMs)
          retryMs = Math.min(retryMs * 2, 30000)
        }

        function connect() {
          if (disposed) return
          let opening
          try {
            opening = new EventSource(STREAM_URL)
          } catch {
            setState((prev) => ({ ...prev, status: 'reconnecting' }))
            schedule()
            return
          }
          source = opening
          opening.onopen = () => {
            retryMs = 1000
            failures = 0
            setState((prev) => ({ ...prev, status: 'live' }))
          }
          opening.onmessage = (event) => {
            let sample
            try {
              sample = JSON.parse(event.data)
            } catch {
              return
            }
            failures = 0
            setState({ sample, status: 'live', lastFrameAt: Date.now() })
          }
          opening.onerror = () => {
            failures += 1
            setState((prev) => ({ ...prev, status: failures > 5 ? 'failed' : 'reconnecting' }))
            try {
              opening.close()
            } catch {
              /* already closed */
            }
            source = null
            schedule()
          }
        }

        connect()
        const watchdog = setInterval(() => {
          setState((prev) => {
            if (prev.lastFrameAt === 0 || prev.status !== 'live') return prev
            if (Date.now() - prev.lastFrameAt <= STALE_AFTER_MS) return prev
            return { ...prev, status: 'stale' }
          })
        }, 1000)

        return () => {
          disposed = true
          clearInterval(watchdog)
          if (retryTimer !== null) clearTimeout(retryTimer)
          if (source !== null) {
            try {
              source.close()
            } catch {
              /* already closed */
            }
          }
        }
      }, [])
      return state
    }

    /** Ambient live readout in the composer dock: one compact line plus a history link. */
    function StatusBar({ translator, onOpenHistory }) {
      const { t } = translator
      useLocaleRevision(translator)
      const { sample, status } = useLiveSample()

      const gpu = sample?.gpu ?? null
      const memUsed = sample?.mem?.used
      const memTotal = sample?.mem?.total
      const vramUsed = gpu?.vramUsed
      const vramTotal = gpu?.vramTotal

      const parts = []
      if (sample === null) {
        parts.push(h('span', { key: 'wait' }, t('connecting')))
      } else {
        parts.push(
          h('span', { key: 'cpu' }, t('cpu'), ' ', h('b', null, formatPercent(sample.cpu?.total))),
        )
        parts.push(
          h(
            'span',
            { key: 'mem' },
            t('mem'),
            ' ',
            h('b', null, `${formatGiB(memUsed)}/${formatGiB(memTotal)}`),
          ),
        )
        if (gpu === null) {
          parts.push(h('span', { key: 'gpu' }, t('gpu'), ' ', h('b', null, t('unavailable'))))
        } else {
          parts.push(h('span', { key: 'gpu' }, t('gpu'), ' ', h('b', null, formatPercent(gpu.util))))
          parts.push(
            h('span', { key: 'vram' }, t('vram'), ' ', h('b', null, `${formatVram(vramUsed)}/${formatVram(vramTotal)}`)),
          )
          parts.push(h('span', { key: 'temp' }, t('temp'), ' ', h('b', null, formatTemp(gpu.tempC))))
        }
      }
      const readout = []
      for (const [index, part] of parts.entries()) {
        if (index > 0) readout.push(h('span', { key: `sep-${index}`, className: 'dss-dock__sep' }, '·'))
        readout.push(part)
      }
      const titleParts = []
      if (sample !== null) {
        titleParts.push(`${t('cpu')} ${formatPercent(sample.cpu?.total)}`)
        titleParts.push(`${t('mem')} ${formatGiB(memUsed)}/${formatGiB(memTotal)}`)
        if (gpu !== null) {
          titleParts.push(`${t('gpu')} ${formatPercent(gpu.util)}`)
          titleParts.push(`${t('vram')} ${formatVram(vramUsed)}/${formatVram(vramTotal)}`)
          titleParts.push(`${t('temp')} ${formatTemp(gpu.tempC)}`)
        } else {
          titleParts.push(`${t('gpu')} ${t('unavailable')}`)
        }
      }
      const statusKey = status === 'live' ? null : status
      const statusText = statusKey === null ? '' : t(statusKey)
      const hint = titleParts.length > 0 ? titleParts.join(' · ') : t('barLabel')

      return h(
        React.Fragment,
        null,
        h(StyleTag),
        h(
          'div',
          { className: 'dss-dock' },
          h(
            'button',
            {
              type: 'button',
              className: 'dss-dock__hit',
              onClick: () => {
                try {
                  onOpenHistory()
                } catch {
                  /* history panel unavailable in this composition */
                }
              },
              title: `${hint} — ${t('openHistory')}`,
              'aria-label': `${hint}. ${t('openHistory')}`,
            },
            h('span', { className: 'dss-dock__dot', 'data-status': status, 'aria-hidden': true }),
            h('span', { className: 'dss-dock__readout' }, readout),
            statusKey === null ? null : h('span', { className: 'dss-dock__status' }, statusText),
          ),
          h('span', { className: 'dss-sr', role: 'status', 'aria-live': 'polite' }, statusText),
        ),
      )
    }

    /** Which series actually carries finite values in this window. */
    function availabilityOf(points) {
      const has = (pick) => points.some((point) => Number.isFinite(pick(point)))
      return {
        cpu: has((point) => point.cpu?.total),
        gpu: has((point) => point.gpu?.util),
        mem: has((point) => point.mem?.total),
        vram: has((point) => point.gpu?.vramTotal),
        temp: has((point) => point.gpu?.tempC),
      }
    }

    /** Split points into runs so a recording gap breaks the line. */
    function segmentsOf(points, pick, bucketMs) {
      const runs = []
      let current = []
      let previousT = null
      const gapMs = Math.max(bucketMs * 2.5, 2000)
      for (const point of points) {
        if (!Number.isFinite(pick(point))) continue
        if (previousT !== null && point.t - previousT > gapMs) {
          if (current.length > 0) runs.push(current)
          current = []
        }
        current.push(point)
        previousT = point.t
      }
      if (current.length > 0) runs.push(current)
      return runs
    }

    /**
     * One SVG line chart over the requested window (not over the data extent),
     * so switching ranges changes the time scale and a gap stays where it was.
     */
    function LineChart({ points, from, until, bucketMs, series, max, unit, ariaLabel, translator }) {
      const WIDTH = 640
      const HEIGHT = 140
      const PAD_X = 8
      const PAD_TOP = 10
      const PAD_BOTTOM = 18
      const [hoverIndex, setHoverIndex] = React.useState(null)
      const { t } = translator

      const span = Math.max(1, until - from)
      const x = (t) => PAD_X + ((t - from) / span) * (WIDTH - PAD_X * 2)
      const finiteValues = []
      for (const point of points) {
        for (const entry of series) {
          const value = entry.get(point)
          if (Number.isFinite(value)) finiteValues.push(value)
        }
      }
      const ceiling = max ?? Math.max(10, Math.ceil((Math.max(...finiteValues, 0) * 1.1) / 10) * 10)
      const y = (value) =>
        HEIGHT - PAD_BOTTOM - (Math.min(Math.max(value, 0), ceiling) / ceiling) * (HEIGHT - PAD_TOP - PAD_BOTTOM)

      const children = []
      for (const fraction of [0, 0.5, 1]) {
        const lineY = PAD_TOP + fraction * (HEIGHT - PAD_TOP - PAD_BOTTOM)
        children.push(
          h('line', {
            key: `grid-${fraction}`,
            className: 'dss-chart__grid',
            x1: PAD_X,
            x2: WIDTH - PAD_X,
            y1: lineY,
            y2: lineY,
            vectorEffect: 'non-scaling-stroke',
          }),
          h(
            'text',
            { key: `gridlabel-${fraction}`, className: 'dss-chart__axis', x: PAD_X, y: lineY - 3 },
            `${Math.round(ceiling * (1 - fraction))}${unit}`,
          ),
        )
      }

      for (const entry of series) {
        for (const [runIndex, run] of segmentsOf(points, entry.get, bucketMs).entries()) {
          if (run.length === 1) {
            children.push(
              h('circle', {
                key: `${entry.key}-dot-${runIndex}`,
                cx: x(run[0].t),
                cy: y(entry.get(run[0])),
                r: 1.8,
                fill: entry.color,
              }),
            )
            continue
          }
          const path = run
            .map(
              (point, index) =>
                `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(entry.get(point)).toFixed(1)}`,
            )
            .join(' ')
          children.push(
            h('path', {
              key: `${entry.key}-${runIndex}`,
              d: path,
              fill: 'none',
              stroke: entry.color,
              strokeWidth: 1.6,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              vectorEffect: 'non-scaling-stroke',
            }),
          )
        }
      }

      const hovered = hoverIndex === null ? null : points[hoverIndex]
      if (hovered !== undefined && hovered !== null) {
        const hoverX = x(hovered.t)
        children.push(
          h('line', {
            key: 'hover',
            className: 'dss-chart__hoverline',
            x1: hoverX,
            x2: hoverX,
            y1: PAD_TOP,
            y2: HEIGHT - PAD_BOTTOM,
            vectorEffect: 'non-scaling-stroke',
          }),
        )
        for (const entry of series) {
          const value = entry.get(hovered)
          if (!Number.isFinite(value)) continue
          children.push(
            h('circle', { key: `hover-${entry.key}`, cx: hoverX, cy: y(value), r: 2.2, fill: entry.color }),
          )
        }
      }

      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        if (rect.width <= 0 || points.length === 0) return
        const targetT = from + ((event.clientX - rect.left) / rect.width) * span
        let best = 0
        let bestDelta = Infinity
        for (let index = 0; index < points.length; index += 1) {
          const delta = Math.abs(points[index].t - targetT)
          if (delta < bestDelta) {
            bestDelta = delta
            best = index
          }
        }
        setHoverIndex(best)
      }

      const hoverText =
        hovered === null || hovered === undefined
          ? t('hoverHint')
          : [
              formatClockSeconds(hovered.t),
              ...series
                .filter((entry) => Number.isFinite(entry.get(hovered)))
                .map((entry) => `${entry.label} ${entry.format ? entry.format(entry.get(hovered)) : entry.get(hovered)}`),
            ].join(' · ')

      return h(
        'div',
        null,
        h(
          'svg',
          {
            className: 'dss-chart',
            viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
            role: 'img',
            'aria-label': ariaLabel,
            onMouseMove: onMove,
            onMouseLeave: () => setHoverIndex(null),
          },
          h('title', { key: 'title' }, ariaLabel),
          children,
        ),
        h(
          'div',
          { className: 'dss-chart__axisrow' },
          h('span', null, formatClock(from)),
          h('span', { className: 'dss-chart__hoverinfo' }, hoverText),
          h('span', null, formatClock(until)),
        ),
      )
    }

    function ChartCard({ title, legend, children, translator, latest }) {
      return h(
        'section',
        { className: 'dss-card' },
        h(
          'div',
          { className: 'dss-card__head' },
          h('h2', { className: 'dss-card__title' }, title),
          latest === undefined || latest === null
            ? null
            : h('span', { className: 'dss-card__latest' }, latest),
          legend === null || legend.length === 0
            ? null
            : h(
                'span',
                { className: 'dss-card__legend' },
                legend.map((entry) =>
                  h(
                    'span',
                    { key: entry.label },
                    h('span', { className: 'dss-legend__swatch', style: { background: entry.color } }),
                    entry.label,
                  ),
                ),
              ),
        ),
        children,
      )
    }

    /** The history panel: window selector, coverage facts, charts, disk usage. */
    function HistoryPage({ translator }) {
      const { t } = translator
      useLocaleRevision(translator)
      const [range, setRange] = React.useState('1h')
      const [attempt, setAttempt] = React.useState(0)
      const [state, setState] = React.useState({
        loading: true,
        error: null,
        points: [],
        from: null,
        until: null,
        bucketMs: 60000,
        disabled: false,
        reason: undefined,
        lastWriteAt: null,
      })
      const titleRef = React.useRef(null)

      React.useEffect(() => {
        if (titleRef.current) titleRef.current.focus()
      }, [])

      React.useEffect(() => {
        let cancelled = false
        setState((prev) => ({ ...prev, loading: true, error: null }))
        fetch(`${HISTORY_URL}?range=${encodeURIComponent(range)}`, { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((payload) => {
            if (cancelled) return
            const fallbackUntil = Date.now()
            const windowMs = RANGE_MS[range] ?? RANGE_MS['1h']
            setState({
              loading: false,
              error: null,
              points: Array.isArray(payload?.points) ? payload.points : [],
              from: Number.isFinite(payload?.from) ? payload.from : fallbackUntil - windowMs,
              until: Number.isFinite(payload?.until) ? payload.until : fallbackUntil,
              bucketMs: Number.isFinite(payload?.bucketMs) ? payload.bucketMs : Math.ceil(windowMs / 300),
              disabled: Boolean(payload?.disabled),
              reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
              lastWriteAt: Number.isFinite(payload?.lastWriteAt) ? payload.lastWriteAt : null,
            })
          })
          .catch((error) => {
            if (cancelled) return
            const windowMs = RANGE_MS[range] ?? RANGE_MS['1h']
            const now = Date.now()
            setState({
              loading: false,
              error: String(error?.message ?? error),
              points: [],
              from: now - windowMs,
              until: now,
              bucketMs: Math.ceil(windowMs / 300),
              disabled: false,
              reason: undefined,
              lastWriteAt: null,
            })
          })
        return () => {
          cancelled = true
        }
      }, [range, attempt])

      // The live hour refreshes itself while the page is visible.
      React.useEffect(() => {
        if (range !== '1h') return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          setAttempt((value) => value + 1)
        }, 30000)
        return () => clearInterval(timer)
      }, [range])

      const points = state.points
      const from = state.from ?? Date.now() - (RANGE_MS[range] ?? RANGE_MS['1h'])
      const until = state.until ?? Date.now()
      const availability = availabilityOf(points)
      const lastPoint = points.length > 0 ? points[points.length - 1] : null
      const rangeLabels = { '1h': 'range1h', '6h': 'range6h', '24h': 'range24h', '7d': 'range7d' }

      const header = h(
        'div',
        { className: 'dss-page__head' },
        h(
          'div',
          { className: 'dss-page__titles' },
          h('h1', { className: 'dss-page__title', tabIndex: -1, ref: titleRef }, t('historyTitle')),
          h(
            'p',
            { className: 'dss-page__sub' },
            `${t('window')} ${formatClock(from)} – ${formatClock(until)}${
              lastPoint === null ? '' : ` · ${t('lastSample')} ${formatClockSeconds(lastPoint.t)}`
            }`,
          ),
        ),
        h(
          'div',
          { className: 'dss-page__ranges', role: 'group', 'aria-label': t('rangeGroup') },
          RANGES.map((value) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                className: 'dss-range',
                'data-active': String(value === range),
                'aria-pressed': value === range,
                onClick: () => {
                  if (value === range) setAttempt((current) => current + 1)
                  else setRange(value)
                },
              },
              t(rangeLabels[value]),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dss-range',
              onClick: () => setAttempt((current) => current + 1),
              title: t('refresh'),
            },
            t('refresh'),
          ),
        ),
      )

      const notices = []
      if (state.disabled) {
        notices.push(
          h('div', { className: 'dss-notice', key: 'disabled' }, t('disabledStorage')),
        )
      }
      if (state.reason === 'unreadable') {
        notices.push(h('div', { className: 'dss-notice dss-notice--error', key: 'unreadable' }, t('unreadableStorage')))
      }

      const cpuSeries = [
        {
          key: 'cpu',
          label: t('cpu'),
          color: 'var(--dsw-alias-brand-primary)',
          get: (point) => point.cpu?.total,
          format: formatPercent,
        },
      ]
      const gpuSeries = [
        {
          key: 'gpu',
          label: t('gpu'),
          color: 'var(--dsw-alias-brand-primary)',
          get: (point) => point.gpu?.util,
          format: formatPercent,
        },
      ]
      const memSeries = [
        {
          key: 'mem',
          label: t('mem'),
          color: 'var(--dsw-alias-brand-primary)',
          get: (point) => (point.mem?.total > 0 ? (point.mem.used / point.mem.total) * 100 : NaN),
          format: formatPercent,
        },
      ]
      const vramSeries = [
        {
          key: 'vram',
          label: t('vram'),
          color: 'var(--dsw-alias-brand-primary)',
          get: (point) =>
            point.gpu?.vramTotal > 0 ? (point.gpu.vramUsed / point.gpu.vramTotal) * 100 : NaN,
          format: formatPercent,
        },
      ]
      const tempSeries = [
        {
          key: 'temp',
          label: t('temp'),
          color: 'var(--dsw-alias-label-primary)',
          get: (point) => point.gpu?.tempC,
          format: formatTemp,
        },
      ]
      const lastCpu = lastPoint?.cpu?.total
      const lastGpu = availability.gpu ? lastPoint?.gpu?.util : null
      const lastMemPercent =
        lastPoint?.mem?.total > 0 ? (lastPoint.mem.used / lastPoint.mem.total) * 100 : null
      const lastVramPercent =
        availability.vram && lastPoint?.gpu?.vramTotal > 0
          ? (lastPoint.gpu.vramUsed / lastPoint.gpu.vramTotal) * 100
          : null
      const cpuLatest = formatPercent(lastCpu)
      const gpuLatest = formatPercent(lastGpu)
      const memLatest = `${formatPercent(lastMemPercent)} · ${formatGiB(lastPoint?.mem?.used)} / ${formatGiB(
        lastPoint?.mem?.total,
      )}`
      const vramLatest = `${formatPercent(lastVramPercent)} · ${formatVram(
        lastPoint?.gpu?.vramUsed,
      )} / ${formatVram(lastPoint?.gpu?.vramTotal)}`

      let body
      if (state.error !== null) {
        body = h(
          'div',
          { className: 'dss-card dss-empty' },
          h('span', { className: 'dss-error' }, `${t('loadFailed')}: ${state.error}`),
          h(
            'button',
            { type: 'button', className: 'dss-retry', onClick: () => setAttempt((value) => value + 1) },
            t('retry'),
          ),
        )
      } else if (state.loading && points.length === 0) {
        body = h('div', { className: 'dss-card dss-empty' }, t('loading'))
      } else if (points.length === 0) {
        body = h('div', { className: 'dss-card dss-empty' }, t('empty'))
      } else {
        const singlePoint = points.length === 1
        body = h(
          React.Fragment,
          null,
          singlePoint ? h('div', { className: 'dss-notice' }, t('singlePoint')) : null,
          h(
            ChartCard,
            {
              title: t('cpuTitle'),
              translator,
              latest: cpuLatest,
              legend: [{ label: t('cpu'), color: 'var(--dsw-alias-brand-primary)' }],
            },
            h(LineChart, {
              points,
              from,
              until,
              bucketMs: state.bucketMs,
              unit: '%',
              series: cpuSeries,
              ariaLabel: `${t('cpuTitle')} ${formatClock(from)}–${formatClock(until)}`,
              translator,
            }),
          ),
          availability.gpu
            ? h(
                ChartCard,
                {
                  title: t('gpuTitle'),
                  translator,
                  latest: gpuLatest,
                  legend: [{ label: t('gpu'), color: 'var(--dsw-alias-brand-primary)' }],
                },
                h(LineChart, {
                  points,
                  from,
                  until,
                  bucketMs: state.bucketMs,
                  unit: '%',
                  series: gpuSeries,
                  ariaLabel: `${t('gpuTitle')} ${formatClock(from)}–${formatClock(until)}`,
                  translator,
                }),
              )
            : null,
          h(
            ChartCard,
            {
              title: t('memory'),
              translator,
              latest: memLatest,
              legend: memSeries.map((entry) => ({ label: entry.label, color: entry.color })),
            },
            h(LineChart, {
              points,
              from,
              until,
              bucketMs: state.bucketMs,
              max: 100,
              unit: '%',
              series: memSeries,
              ariaLabel: `${t('memory')} ${formatClock(from)}–${formatClock(until)}`,
              translator,
            }),
          ),
          availability.vram
            ? h(
                ChartCard,
                {
                  title: t('vramTitle'),
                  translator,
                  latest: vramLatest,
                  legend: [{ label: t('vram'), color: 'var(--dsw-alias-brand-primary)' }],
                },
                h(LineChart, {
                  points,
                  from,
                  until,
                  bucketMs: state.bucketMs,
                  unit: '%',
                  series: vramSeries,
                  ariaLabel: `${t('vramTitle')} ${formatClock(from)}–${formatClock(until)}`,
                  translator,
                }),
              )
            : null,
          availability.temp
            ? h(
                ChartCard,
                {
                  title: t('temperature'),
                  translator,
                  latest: formatTemp(lastPoint?.gpu?.tempC),
                  legend: [{ label: t('temp'), color: 'var(--dsw-alias-label-primary)' }],
                },
                h(LineChart, {
                  points,
                  from,
                  until,
                  bucketMs: state.bucketMs,
                  unit: '°',
                  series: tempSeries,
                  ariaLabel: `${t('temperature')} ${formatClock(from)}–${formatClock(until)}`,
                  translator,
                }),
              )
            : null,
          availability.gpu
            ? null
            : h('div', { className: 'dss-notice' }, `${t('gpu')}: ${t('gpuUnavailable')}`),
          h(
            ChartCard,
            { title: t('disks'), translator, legend: null },
            (lastPoint?.disks ?? []).length === 0
              ? h('div', { className: 'dss-empty' }, t('unavailable'))
              : (lastPoint?.disks ?? []).map((disk) => {
                  const percent = disk.total > 0 ? ((disk.total - disk.free) / disk.total) * 100 : 0
                  return h(
                    'div',
                    { className: 'dss-disk', key: disk.id },
                    h('span', null, disk.id),
                    h(
                      'span',
                      { className: 'dss-disk__track' },
                      h('span', {
                        className: 'dss-disk__fill',
                        style: { width: `${Math.max(0, Math.min(100, percent)).toFixed(1)}%` },
                      }),
                    ),
                    h(
                      'span',
                      { className: 'dss-disk__value' },
                      `${t('usedPercent')} ${formatPercent(percent)} · ${t('free')} ${formatGiB(
                        disk.free,
                      )} / ${t('total')} ${formatGiB(disk.total)}`,
                    ),
                  )
                }),
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h(StyleTag),
        h(
          'div',
          { className: 'dss-page' },
          h('div', { className: 'dss-page__inner' }, header, notices, body, h('div', { className: 'dss-foot' }, t('runtimeOnly'))),
        ),
      )
    }

    function SidebarIcon({ size = 16, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4 17.5 8 12l3.2 3.4L15 9.5l5 8',
          stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4 20.5h16',
          stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          opacity: 0.55,
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const translator = createTranslator(ctx)
        if (translator.disposers.length > 0) {
          ctx.effect(() => () => {
            for (const dispose of translator.disposers) {
              try {
                dispose()
              } catch {
                /* already removed */
              }
            }
          })
        }
        const openHistory = () => {
          const layout = typeof ctx.get === 'function' ? ctx.get('layout') : null
          if (layout) layout.selectPanel('system-status')
        }

        // Live readout in the composer dock, in the dock's own compact idiom.
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'system-status-bar',
              order: 40,
              label: () => translator.t('barLabel'),
            },
            () => h(StatusBar, { translator, onOpenHistory: openHistory }),
          ),
        )

        // Left sidebar entry: the shell owns the button, we own the glyph.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'system-status',
              order: 20,
              label: () => translator.t('panelTitle'),
            },
            SidebarIcon,
          ),
        )

        // The history page, selected by that entry's id.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'system-status' }, () =>
            h(HistoryPage, { translator }),
          ),
        )
      },
    }
  },
})
