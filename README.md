# dsh-plugin-system-status

[![npm version](https://img.shields.io/npm/v/dsh-plugin-system-status.svg)](https://www.npmjs.com/package/dsh-plugin-system-status)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在对话页输入框下方常驻显示本机的 **CPU、内存、GPU、显存、GPU 温度** 实时读数，并从左侧栏进入 **历史曲线**（CPU、GPU、内存、显存、GPU 温度、各磁盘已用空间）。

A DSH plugin (`dsh-plugin`) that shows live CPU / memory / GPU / VRAM / GPU temperature under the composer, with historical charts behind a left-sidebar entry. Install it by name: `dsh-plugin-system-status`.

<p align="center"><img src="icon.svg" width="96" height="96" alt="System status icon"></p>

## 功能

- **实时读数**（对话页，输入框正下方）：一行紧凑读数，含状态圆点；整行可点击进入历史页，悬停有高亮，键盘可聚焦。数据断流时显示「重连中 / 数据已过期」，并有指数退避重连。
- **历史曲线**（左侧栏「系统状态」图标）：CPU、GPU、内存、显存各一张曲线图（纵轴自动缩放，标题旁显示最新值），GPU 温度一张，磁盘已用空间条形图；支持近 1 小时 / 6 小时 / 24 小时 / 7 天四档。
- **如实的时间轴**：横轴是所选时间窗口而不是数据实际跨度；DSH 未运行造成的断档在图上断开，不画直线跨接；鼠标在图内移动可读出该时刻的数值。
- **降级**：没有可用 NVIDIA GPU（或 `nvidia-smi` 不在 PATH）时，GPU 相关项显示「不可用」，其余指标照常；历史目录不可写时只保留实时数据并给出提示。

## 安装

**从 npm（推荐）**：在 DSH 里打开 **Settings → Plugins → Add plugin**，输入包名 `dsh-plugin-system-status` 后点「安装」；或让 DSH 的 agent 调用 `plugin_manager` 的 `install_bundle`，`target` 传 `dsh-plugin-system-status`。

**从本仓库（开发或自定义用）**：

1. 克隆仓库到本地：
   ```powershell
   git clone https://github.com/chenmohan123/dsh-plugin-system-status.git
   ```
2. **Settings → Plugins → Add plugin** 选择仓库目录，或在 `install_bundle` 的 `target` 里传该目录的绝对路径。
3. 首次安装经热更新生效，**刷新一次页面**即可看到实时读数与左侧栏图标。

包名是 `dsh-plugin-system-status`（发布在 npm），`cordis.patch.yml` 里的行 id 是 `system-status`。

## 数据与实现

| 指标 | 来源 |
|---|---|
| CPU 利用率（总 / 每核） | Node `os.cpus()` 两次差分 |
| 内存已用 / 总量 | `os.totalmem()` / `os.freemem()` |
| 磁盘已用 / 总量 | Node `fs.statfs`，遍历固定盘符 |
| GPU 利用率、显存、温度、功耗、风扇 | 常驻一个 `nvidia-smi --loop-ms=3000` 子进程读取 |

- **采样**：每 3 秒一个样本；Host 半把样本通过同源 SSE 路由 `/dsh-system-status/stream` 推给页面，历史查询走 `/dsh-system-status/history?range=1h|6h|24h|7d`。
- **持久化**：每 5 秒批量追加到 `%DSH_HOME%/system-status/YYYY-MM-DD.jsonl`（默认 `C:\Users\<你>\.dsh\system-status\`），保留 7 天；读取时按档位分桶聚合、降采样到约 300 点。
- **不引入任何运行时依赖**：Host 半只用 Node 内置模块，Client 半只用宿主提供的 React；图表是手绘 SVG。
- **数据面**：路由只返回纯数值，不含机器名、用户名、路径，且只监听 DSH 自己的回环地址。

## 限制

- **GPU 数据仅支持 NVIDIA**：来自 `nvidia-smi`。集成显卡（Intel / AMD APU）与 AMD 独立显卡暂时不显示 GPU 信息，实时条与历史页会标注「未检测到 NVIDIA 显卡」。Windows 自带的 WDDM 计数器能读到这些显卡的利用率与内存占用，但既没有温度、也没有显存总量，且单次读取需 1–3.5 秒，会拖慢 3 秒的采样节奏，因此没有采用。
- **只有 GPU 温度**：Windows 的 ACPI 热区接口（`MSAcpi_ThermalZoneTemperature`）拒绝访问，CPU / 主板温度需要 LibreHardwareMonitor 这类带内核驱动的工具，本插件未接入。
- **历史只在 DSH 运行时采样**：DSH 关闭、休眠、关机期间没有数据。
- **采样频率与保留期是代码常量**（3 秒 / 7 天），暂未暴露成配置项。
- 主要在 Windows 11 + NVIDIA 显卡上开发验证；macOS / Linux 未验证，`nvidia-smi` 与盘符枚举的行为可能有差异。

## 开发

要求 Node.js 20+（仅用于跑单测与语法检查；插件运行在 DSH 自己的进程里）。

```powershell
node --check client.js
node --check index.js
node --test
```

单测覆盖：GPU CSV 解析与子进程生命周期、CPU 差分与采样装配、历史聚合/降采样/保留期/坏行容错、路由的 SSE 帧与错误状态。

目录结构：

```
index.js              Host 半：装配采样、历史存储与路由
host/gpu.js           nvidia-smi 常驻采样源
host/sampler.js       CPU / 内存 / 磁盘 / GPU 样本组装
host/history.js       按天 JSONL、保留期、分桶聚合与降采样
host/routes.js        SSE 与历史查询路由
client.js             Client 半：侧栏图标、实时读数、历史页（手绘 SVG 图表）
locale/*.json         插件在 Plugins 页的标题与详情
docs/DETAIL.md        插件详情页文案
docs/superpowers/     设计文档与实现计划
test/                 单测
icon.svg              插件图标
```

## 许可

[MIT](LICENSE) © 2026 陈默涵 (chenmohan123)
