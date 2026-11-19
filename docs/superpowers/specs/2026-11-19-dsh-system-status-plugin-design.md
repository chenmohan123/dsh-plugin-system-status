# DSH 系统状态插件 设计文档

日期：2026-11-19
状态：待批准

## 意图与原因

在 DeepSeek Harness 里随时看到这台机器的硬件状况：实时看关键几个数字，需要复盘时看历史曲线。
用户是这台 Windows 11 机器（DSH desktop 0.2.2-rc.5）的唯一使用者，
目标是自己用着方便，不做通用监控产品。

## 目标

1. **实时**：对话页输入框正下方一条常驻状态条，约每 3 秒刷新，显示 CPU 占用、内存占用、GPU 利用率、显存占用、GPU 温度；整条可点击进入历史页。
2. **历史**：左侧栏新增一个「系统状态」图标，点开是整页历史图表，可在 1h / 6h / 24h / 7d 四档时间范围间切换，展示 CPU、内存、GPU、显存、磁盘容量、GPU 温度的曲线。
3. **持久化**：历史采样落本地文件，默认保留 7 天，跨 DSH 重启保留。只记录 DSH Host 进程存活期间：关掉 DSH、休眠、关机的时间段没有数据，历史页把断档如实留空（不画线跨接）并在页脚注明「仅在 DSH 运行时记录」。
4. **可控**：插件在 Plugins 页可开关；关闭后不再采样、不残留子进程；卸载后不留后台任务。

## 非目标

- 不做进程级排行（谁在吃 CPU/显存）。
- 不做磁盘读写吞吐（Windows 上需要性能计数器，成本与收益不匹配）。
- 不做 CPU / 主板温度（见下方约束与风险，只留接入位）。
- 不做告警、通知、阈值。
- 不做远程机器或多机聚合。

## 反目标（技术上做到了也算失败）

- 让 DSH 主进程或页面明显变慢（采样、SSE、渲染任一项成为负担）。
- 留下失控的 `nvidia-smi` 子进程或定时器。
- 页面用写死颜色，切换明暗主题后不可读。
- 把机器名、用户名、路径等可识别信息暴露给浏览器或写进日志。

## 约束（实测与已核实）

- **数据源**：`nvidia-smi` 可用，已实测返回形如 `NVIDIA GeForce …, 16311 MiB, 2 %, 47.31 ℃`（利用率、显存、温度、功耗、风扇均可查）。
  CPU 占用 / 内存由 Node `os` 差分得到；磁盘容量由 `fs.statfs` 按卷得到。
- **CPU/主板温度拿不到**：Windows 的 ACPI 热区接口 `MSAcpi_ThermalZoneTemperature` 实测「拒绝访问」，真实数值需要 LibreHardwareMonitor 这类带内核驱动的工具。首版只做 GPU 温度，Host 里留一个可选适配位（Config 里的 CPU 温度来源，首版不实现）。
- **页面渲染面**：客户端插件运行在浏览器模块表里，只有 React 等基线模块，拿不到图表库，所以图表自绘 SVG。
- **样式**：容器和文字必须使用 `--dsw-alias-*` 主题 token，明暗主题都从宿主继承。
- **机制已核实**：左栏图标走 `sidebar.panellist` 列表插槽（own id），整页走 keyed `main` 插槽同名 key，导航用 `ctx.layout.selectPanel(id)`；实时条走 `conversation.composer.dock` 列表插槽。

## 方案（用户已选定 A）

- **A. 同源 HTTP 路由 + SSE（选定）**：Host 半采样并注册同源路由，Client 用 `fetch` 订阅 SSE。同源因此没有 CORS 与鉴权拼接问题；SSE 比每秒轮询省资源；DSH 自带的 open-in-app 就是 webServer 路由 + 客户端 fetch 这套。
- **B. 官方 @Remote 服务（否决）**：最"官方"，但动态手写的客户端插件能否拿到自定义 `ctx.remote.*` 命名空间取决于 typert 生成物，未经验证，卡住代价高。
- **C. 独立本地端口（否决）**：调试方便，但多一个监听端口、要处理跨源，安全面和惯例都不如 A。

## 做法

### 交付物

一个本地安装的 bundle 包 `dsh-plugin-system-status`（发布到 npm），含 Host 半与 Client 半：

```
package.json          dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      插入一行 Host 插件
index.js              Host 半：采样、历史存储、HTTP/SSE 路由
client.js             Client 半：侧栏图标、历史页、实时条
locale/en.json, locale/zh.json
docs/DETAIL.md        插件详情页文案
icon.svg              插件图标
```

### Host 半（index.js）

- **采样器**：3 秒一个 tick。CPU 用 `os.cpus()` 两次差分的各核占用加总；内存用 `os.totalmem()/freemem()`；磁盘用 `fs.statfs` 遍历固定卷得到总容量/可用；GPU 常驻一个 `nvidia-smi --query-gpu=... --format=csv,noheader,nounits --loop-ms=3000` 子进程持续读（若实测该组合在 Windows 上没有 `--loop`，退化为每 tick spawn 一次）。
- **历史存储**：内存里保留最近 60 分钟（3 秒精度）环形缓冲；每 5 秒把新增样本追加到 `%DSH_HOME%/system-status/YYYY-MM-DD.jsonl`；启动时清理超过保留天数的文件。
- **样本字段（落盘即契约，升级必须兼容旧行）**：`{ t, cpu: { total, perCore[] }, mem: { used, total }, gpu: { util, vramUsed, vramTotal, tempC, powerW } | null, disks: [{ id: 'C:', total, free }] }`。断档表现为时间戳间隔，不写占位行。
- **磁盘**：按固定卷各一条 `{ id, total, free }`，`id` 用盘符（`C:`），不是路径；历史页画每卷的「已用百分比」曲线，悬停显示已用/总量。总容量不单独画曲线——恒定值没有信息量。
- **路由**（同源，只返回数值，不含机器名/用户名/路径）：
  - `GET /dsh-system-status/stream`：SSE，3 秒一帧当前样本。
  - `GET /dsh-system-status/history?range=1h|6h|24h|7d`：返回按档位降采样到约 300 点的序列。
- **生命周期**：定时器、子进程、SSE 连接、路由全部在 `apply` 的 effect 内注册并返回清理函数；插件卸载 = 全部停止。
- **Config**：采样间隔、保留天数、是否启用 GPU 采集。CPU 温度来源只留代码里的适配位，不做成 Config 旋钮——首版它不会有任何效果。

### Client 半（client.js）

- `sidebar.panellist` 注册 `id: system-status` 的图标单元（自绘 SVG，按 `active` 高亮），点击调 `ctx.layout.selectPanel('system-status')`。
- `main` 注册 key `system-status` 的历史页：时间档切换、SVG 折线、磁盘容量条形、空态/错误态；悬停显示该点数值。
- `conversation.composer.dock` 注册实时条：订阅 SSE，四个数字 + 温度，点击整条进入历史页；断线时显示「重连中」并按指数退避重连。
- 文案全部走 Client locale 服务，中英各一份。

### 降级路径

- `nvidia-smi` 不存在或报错 → GPU 区块显示「不可用」，其余照常。
- SSE 断开 → 状态条显示重连中，不停摆页面。
- 历史路由失败 → 历史页显示错误提示与重试按钮。

## 验证

1. 安装后 Plugins 页出现该插件、标题描述图标正确。
2. 新会话对话页出现实时条，数值与任务管理器抽查一致（±1 tick 内）。
3. 点左栏图标进入历史页，曲线随采样增长，四档时间范围都能切。
4. 刷新页面后历史仍在；重启 DSH 后历史仍在。
5. 禁用插件后实时条消失、`nvidia-smi` 子进程消失；重新启用后恢复。

**交付与验收分工**：我把 bundle 建在当前工作区并装进 profile（首次安装经热更新生效，不需要重启 DSH）；请你刷新页面一次，然后一起确认。我能验证插件状态、路由可达（shell 可用时直接取一帧数据）、插槽注册情况；**页面的视觉效果与数字是否准确需要你确认**——这个会话没有浏览器控制工具。

## 已知风险（首版先验证再往下做）

1. **同源路由的鉴权**：已读 `@deepseek-ai/dsh-host-webserver` 源码确认——webServer 的请求分发只做路径匹配然后直接调用 handler，cookie / Host / Origin 检查在连接层自己的 `/api` handler 里，插件注册的路由不受它管。因此页面里 `fetch('/dsh-system-status/...')` 能直连，不需要 token。代价是这条路由对本机其他进程也可读，所以只暴露纯数值、不含机器名/用户名/路径，并且只在 127.0.0.1 上。
2. **`nvidia-smi` 参数与字段**：已实测——`--loop-ms` 受支持；`memory.used / memory.total / utilization.gpu / temperature.gpu / power.draw / fan.speed` 全部可取（本机实读数：2159/16311 MiB、4%、47.75 ℃、16.57 W、风扇 0）。因此常驻 loop 子进程方案成立，不需要退化为每 tick 单次调用。
3. **`sidebar.panellist` 单元尺寸与 props**：以实测为准（catalog 声明为 `{size, active}`）。

## 留给实现者的决定

SSE 帧格式、降采样算法、图表配色与线宽、磁盘卷的展示形态、实时条的具体排版。
