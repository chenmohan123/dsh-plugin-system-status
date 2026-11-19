# DSH 系统状态插件 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DSH 里提供系统状态实时条（输入框下方）与历史曲线页（左栏图标进入），数据来自本机采样。

**Architecture:** 一个本地 bundle 包，Host 半（Node）每 1 秒采样 CPU/内存/磁盘/GPU，把样本广播给同源 SSE 路由，并按 5 秒批量追加进按天 JSONL；Client 半（浏览器 React）注册三个插槽：`conversation.composer.dock` 实时条、`sidebar.panellist` 图标、`main` 历史页。

**Tech Stack:** 纯 ESM JavaScript（无运行时依赖）、Node 内置 `node:os` / `node:fs`、`nvidia-smi` 子进程、`node:test` 单测、浏览器 `EventSource`、手写 SVG 图表、React（宿主基线模块）。

**Spec:** `docs/superpowers/specs/2026-11-19-dsh-system-status-plugin-design.md`

## Global Constraints

- 运行环境：Windows 11 + DSH desktop 0.2.2-rc.5，Web GUI 与插件同源（`http://127.0.0.1:56812`）。
- **零运行时依赖**：不 import 任何 `@deepseek-ai/*` 或第三方包（宿主进程的模块解析不可依赖）；Host 半只用 `node:*` 内置模块，Client 半只用模块表里的 `react`。
- Client 半必须是**单个文件** `client.js`（模块表按包名加载一个入口），内部按区块注释分段。
- 颜色只能引用 `--dsw-alias-*` 主题 token；布局参考宿主同类控件，不用写死像素色。
- 路由只暴露纯数值，不含机器名、用户名、路径；不得注册 fallback，不得改动其它插件路由。
- 所有定时器、子进程、路由、SSE 连接必须在 `apply` 的 effect 内注册并返回清理函数。
- 数据目录 `%DSH_HOME%/system-status`（`DSH_HOME` 缺省 `~/.dsh`）；不可写时降级为仅内存实时。
- 样本字段固定为：`{ t, cpu:{ total, perCore[] }, mem:{ used, total }, gpu:{ util, vramUsed, vramTotal, tempC, powerW } | null, disks:[{ id, total, free }] }`。
- 本机 GPU：NVIDIA 显卡 16 GB；`nvidia-smi` 字段实测可用：`memory.used / memory.total / utilization.gpu / temperature.gpu / power.draw / fan.speed`。

## Review Focus

1. `nvidia-smi` 不存在、卡住或输出异常 → GPU 区块显示不可用，采样循环不得卡死或抛错中断。
2. 页面刷新 / 关闭标签 / SSE 断开 → 服务端连接被清理，客户端指数退避重连，不产生连接泄漏。
3. 插件禁用或卸载 → 子进程、定时器、路由、SSE 全部释放；重新启用能恢复。
4. 历史文件半行、坏行、旧字段 → 读取时跳过坏行并兼容缺失字段，不抛错、不整段丢弃。
5. DSH 未运行造成的断档 → 曲线断开而不是跨接直线；时间轴与档位选择正确。
6. `%DSH_HOME%` 不可写 → 历史禁用但实时条仍工作，历史页显示说明而不是崩溃。

---

### Task 1: 可安装的包骨架（图标 + 空历史页 + 空实时条）

**Files:**
- Create: `package.json`, `cordis.patch.yml`, `index.js`, `client.js`, `locale/zh.json`, `locale/en.json`, `icon.svg`, `docs/DETAIL.md`

**Interfaces:**
- Produces: 包名 `@local/dsh-system-status`；Client 半注册三个插槽：`sidebar.panellist`（id `system-status`）、`main`（key `system-status`）、`conversation.composer.dock`（id `system-status-bar`）；Host 半 `apply(ctx)` 恒定注册两条路由 `/dsh-system-status/stream`、`/dsh-system-status/history`。

- [ ] **Step 1:** 写 `package.json`：`type: module`，`exports` 含 `.` / `./client` / `./locale/*.json` / `./icon`，`files` 覆盖运行时文件，`dsh.bundle.patch: ./cordis.patch.yml`，`dsh.client: { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-conversation','@deepseek-ai/dsh-client-ui-layout','@deepseek-ai/dsh-client-ui-sidebar'] }`。
- [ ] **Step 2:** 写 `cordis.patch.yml`：插入一行 `id: system-status`、`name: '@local/dsh-system-status'`。
- [ ] **Step 3:** 写占位 `index.js`（`export function apply(ctx)` 只注册两条返回固定 JSON 的路由）与占位 `client.js`（`window.__ModuleLoader__.load` 注册三个插槽，每个都渲染一行本地化标题文本）。
- [ ] **Step 4:** 写 `locale/zh.json`、`locale/en.json`（`meta.title` = 系统状态 / System status，`meta.description` 概述、`meta.detail: docs/DETAIL.md`）、`icon.svg`（自绘仪表盘图标）、`docs/DETAIL.md`（功能、用法、限制：仅 DSH 运行时记录、仅 GPU 温度）。
- [ ] **Step 5:** `node --check index.js` 与 `node --check client.js`，预期无输出。
- [ ] **Step 6:** `plugin_manager install_bundle` 安装本目录，读结果确认 `application: applied`。
- [ ] **Step 7:** `cordis_inspect_query`（Client `Slots.listSubTree`，root 分别为 `sidebar.panellist` 与 `main`）确认 occupant 出现。

### Task 2: GPU 采样源

**Files:**
- Create: `host/gpu.js`, `test/gpu.test.js`

**Interfaces:**
- Produces: `createGpuSource({ command = 'nvidia-smi' })` → `{ read(): GpuSample | null, stop(): void }`，`GpuSample = { util, vramUsed, vramTotal, tempC, powerW }`。
- Produces: `parseGpuLine(line: string): GpuSample | null`（导出供测试）。

- [ ] **Step 1:** 写失败测试 `test/gpu.test.js`：`parseGpuLine('NVIDIA GeForce RTX 5060 Ti, 2159, 16311, 4, 47.75, 16.57, 0')` 返回 `{ util: 4, vramUsed: 2159, vramTotal: 16311, tempC: 47.75, powerW: 16.57 }`；`parseGpuLine('')`、`parseGpuLine('[N/A], [N/A], 1, 1, [N/A], [N/A], [N/A]')` 返回 `null` 或把不可用字段置 null。
- [ ] **Step 2:** `node --test test/gpu.test.js`，预期 FAIL（模块不存在）。
- [ ] **Step 3:** 实现 `host/gpu.js`：`createGpuSource` 用 `spawn` 起常驻 `nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits --loop-ms=1000`，按行喂 `parseGpuLine` 更新缓存最新值；`stop()` 杀子进程；spawn 失败时 `read()` 恒为 `null` 且每分钟重试一次 spawn。
- [ ] **Step 4:** 跑测试 PASS；再跑一次真实探测脚本确认 `read()` 有值。
- [ ] **Step 5:** Commit。

### Task 3: CPU / 内存 / 磁盘采样与样本组装

**Files:**
- Create: `host/sampler.js`, `test/sampler.test.js`

**Interfaces:**
- Consumes: `host/gpu.js` 的 `createGpuSource().read()`。
- Produces: `cpuPercent(prevCpus, nextCpus): { total, perCore[] }`、`listFixedVolumes(): Promise<Array<{id,total,free}>>`、`createSampler({ gpu, now }): { tick(): Sample, start(): void, stop(): void, subscribe(fn): () => void }`。

- [ ] **Step 1:** 写失败测试：给定两份 `os.cpus()` 形状的假数据，`cpuPercent` 返回预期百分比（含 0 与 100 边界、idle 全 0 时不除零）；`createSampler` 用假 gpu 与假时钟 `tick()` 一次，断言样本字段完备且 `t` 为注入时钟值。
- [ ] **Step 2:** `node --test test/sampler.test.js`，预期 FAIL。
- [ ] **Step 3:** 实现：CPU 用 `os.cpus()` 差分（总占用 = 100 - idle占比），内存 `os.totalmem/freemem`，磁盘用 `fs.promises.statfs` 依次探测盘符 A–Z 中存在的固定卷（只保留 Windows 上 `statfs` 成功的字母），失败吞掉并返回已有卷。
- [ ] **Step 4:** 跑测试 PASS。
- [ ] **Step 5:** Commit。

### Task 4: 历史存储与降采样

**Files:**
- Create: `host/history.js`, `test/history.test.js`

**Interfaces:**
- Produces: `createHistoryStore({ dir, retentionDays = 7, flushMs = 5000 })` → `{ push(sample): void, flush(): Promise<void>, read(range): Promise<{ points: Sample[] , disabled?: boolean }>, close(): Promise<void> }`，`range ∈ '1h'|'6h'|'24h'|'7d'`。
- Produces: `downsample(samples, maxPoints = 300): Sample[]` 与 `parseLines(text): Sample[]`（导出供测试）。

- [ ] **Step 1:** 写失败测试（用临时目录）：坏行 JSON 被跳过、缺字段的旧行被跳过；`downsample` 在 1000 个 1 秒点上返回 ≤ 300 点且首尾时间保留；`read('1h')` 只返回窗口内点。
- [ ] **Step 2:** `node --test test/history.test.js`，预期 FAIL。
- [ ] **Step 3:** 实现：按 `YYYY-MM-DD.jsonl` 追加，`flush()` 写盘；启动时删除超过 `retentionDays` 的文件；`read` 读窗口涉及的文件、`parseLines` 容错、按 `bucketMs` 聚合后 `downsample`；目录不可写时 `disabled: true` 且 `push` 变空操作。
- [ ] **Step 4:** 跑测试 PASS。
- [ ] **Step 5:** Commit。

### Task 5: HTTP/SSE 路由与插件装配

**Files:**
- Create: `host/routes.js`
- Modify: `index.js`
- Create: `test/routes.test.js`

**Interfaces:**
- Consumes: Task 3 的 `createSampler`、Task 4 的 `createHistoryStore`。
- Produces: `registerRoutes(webServer, { sampler, history }): () => void`（返回 disposer）；`index.js` 的 `apply(ctx)` 装配全部并返回清理。
- Produces: SSE 帧格式 `data: <JSON Sample>\n\n`；history 响应 `{ points: Sample[], disabled?: true }`。

- [ ] **Step 1:** 写失败测试：用 `node:http` 起测试服务器挂 `registerRoutes`，`GET /dsh-system-status/history?range=1h` 返回 200 JSON；`GET /dsh-system-status/stream` 返回 `content-type: text/event-stream` 且收到至少一帧 `data:`；客户端断开后服务器连接集合清空（用 `registerRoutes` 返回 disposer 之后断言无残留）。
- [ ] **Step 2:** `node --test test/routes.test.js`，预期 FAIL。
- [ ] **Step 3:** 实现 `host/routes.js`（SSE 连接 Set、`req.on('close')` 清理、每 tick `write('data: '+JSON.stringify(sample)+'\n\n')`、history 走 `history.read`）；`index.js` 用 `export const inject = ['webServer']`，在 `ctx.effect` 内起采样器、注册路由、启动 history flush，并返回统一清理。
- [ ] **Step 4:** 跑测试 PASS。
- [ ] **Step 5:** 重新 `install_bundle`（同包需重启才换 JS 生成；先记录这一限制），并用 `curl http://127.0.0.1:56812/dsh-system-status/history?range=1h` 与 `curl -N .../stream` 各验一次真实数据。
- [ ] **Step 6:** Commit。

### Task 6: 客户端实时条

**Files:**
- Modify: `client.js`（新增 `StatusBar` 区块）

**Interfaces:**
- Consumes: `/dsh-system-status/stream`（SSE），`ctx.layout.selectPanel('system-status')`。
- Produces: `useLiveSample()` 钩子（返回最新 `Sample | null` 与连接状态）；`StatusBar` 组件。

- [ ] **Step 1:** 先用 `cordis_inspect_query`（Client `Service`，service `locale`）确认 locale 注册/绑定的准确调用形态，按结果决定用 locale 服务还是内联字典。
- [ ] **Step 2:** 用 `cordis_inspect_query`（Client `Theme`）列出 token，选定背景/边框/文字的 token。
- [ ] **Step 3:** 实现 `useLiveSample`（`EventSource`，`onerror` 后 1s→2s→4s…上限 30s 重连，组件卸载时 `close()`）与 `StatusBar`（CPU%、内存%、GPU%、显存 GB、GPU 温度；GPU 不可用显示「不可用」；整条 `role="button"` 点击进历史页）。
- [ ] **Step 4:** `node --check client.js`，刷新页面后确认数值与任务管理器一致（用户确认）。
- [ ] **Step 5:** Commit。

### Task 7: 客户端历史页

**Files:**
- Modify: `client.js`（新增 `HistoryPage` 区块）

**Interfaces:**
- Consumes: `/dsh-system-status/history?range=...`，Task 6 的样本字段。
- Produces: `HistoryPage` 组件（time-range 切换、折线、磁盘条形、空态/错误态）。

- [ ] **Step 1:** 实现 `sparkPath(points, key, width, height)` 折线路径生成（纯函数，导出到 `window.__systemStatusTest` 供 Node 侧单测复用不现实，改为在 `test/client-pure.test.js` 里通过读取对象示例数据单测；若不便导出则删掉本步单测，改为页面实测）。
- [ ] **Step 2:** 实现 `HistoryPage`：四个档位按钮、三块折线（CPU/GPU、内存/显存、GPU 温度）、磁盘已用百分比条形、断档处断开折线、页脚「仅在 DSH 运行时记录」、加载/错误/空态。
- [ ] **Step 3:** `node --check client.js`；刷新页面进入历史页，四档都能切、曲线随时间增长（用户确认）。
- [ ] **Step 4:** Commit。

### Task 8: 收尾、安装验收与体验评审

**Files:**
- Modify: `docs/DETAIL.md`（如有偏差则更新）、`locale/*.json`（文案校准）
- Verify: 全部

- [ ] **Step 1:** 跑全部单测：`node --test test/`，预期全 PASS。
- [ ] **Step 2:** 卸载/禁用验证：`plugin_manager` 禁用插件后 `nvidia-smi` 子进程消失、`/dsh-system-status/stream` 返回 404；重新启用后恢复。
- [ ] **Step 3:** 历史持久化验证：刷新页面后历史仍在；`%DSH_HOME%/system-status/*.jsonl` 有当日文件。
- [ ] **Step 4:** 按 `references/verification.md` 跑一次 UI/UX 评审子代理（给出目标、位置、可用证据），修掉实质问题。
- [ ] **Step 5:** 交付说明：安装位置、验证结果、未验证项（视觉需用户确认）。
- [ ] **Step 6:** Commit。

---

## Self-Review

- Spec 覆盖：实时条（Task 6）、历史页（Task 7）、左栏入口（Task 1/7）、持久化与保留（Task 4）、GPU/CPU/内存/磁盘采样（Task 2/3）、路由（Task 5）、降级（Task 2/4/6）、验收与评审（Task 8）。**Config 旋钮未覆盖**：宿主进程无法可靠 import 配置校验库，首版把三个参数写成模块常量；这偏离 spec 的 Config 一节，交付时明确说明。
- 断档渲染（Review Focus 5）落在 Task 7 Step 2；坏行容错（Focus 4）在 Task 4 Step 1；子进程/定时器释放（Focus 3）在 Task 5 Step 5 与 Task 8 Step 2；`DSH_HOME` 不可写（Focus 6）在 Task 4 Step 3。
