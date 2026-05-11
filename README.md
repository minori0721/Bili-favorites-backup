# Bili-favorites-backup

## v2.1.7 备份策略说明

- 备份状态按“账号 + 收藏夹 + BV号”记录，同一个视频如果同时存在于多个收藏夹，会分别保证每个收藏夹对应的 AList 目录都有文件。
- 自动同步会持续扫描收藏夹深处内容。初始化阶段每轮会补扫更多历史页；手动“立即同步”也会比普通自动轮询扫得更深。
- AList 状态对账会按 BV号匹配远端文件名，不再因为目录里存在其他视频就误判当前视频已经上传。
- 取消收藏不会删除已经上传的文件；如果 AList 侧文件被删，后续对账会重新标记并补传。
- v2.1.6 起，带有历史上传证明的全局记录会先作为“待远端确认”的关系级状态导入，避免更新后把已备份视频成批重新下载；BBDown 解析失败也不会再被误报为下载完成。
- 队列级下载/上传失败会写入网页日志；解析失败会离开当前队列，避免同一轮反复重试刷屏。
- `解析此分P失败` 会退出当前任务队列，等下一轮同步再次入队；明确下架、不可见或 `Arg_KeyNotFound` 才会停止自动重试。

一个全自动化 Node.js 服务：定时监控 Bilibili 收藏夹，使用 BBDown 高清下载，并通过 AList 直连 WebDAV 自动同步归档到各类国内网盘（如阿里云盘、夸克、百度网盘、115等）。

## ✨ 核心特性

- **🟢 纯粹的 Miku 绿清新主题**：焕然一新的现代化 Web UI，全平台自适应，极具质感。
- **📺 稳定 TV 端登录**：采用 Bilibili TV 端 API 进行扫码登录，有效绕过 Web 端的严苛风控限制。
- **⚡ 高性能任务队列**：内置生产-消费队列模型，支持**自定义并发数**与**失败智能重试**，杜绝卡死阻塞。
- **🎞️ 深度定制 BBDown**：网页端直观选择视频编码 (HEVC/AVC/AV1)、强制画质 (4K/8K)、以及下载 Hi-Res 和杜比音效。
- **☁️ AList 极简挂载体验**：彻底告别繁琐的命令行配置，自带 AList 面板，全中文可视化挂载你的任意网盘。也可以直接接入你已有的 AList。
- **📦 Docker 一键部署**：开箱即用，所有配置皆可通过前端 Web 面板热重载生效。
- **🖼️ 可视化收藏夹浏览**：收藏夹带封面缩略图展示，点击可展开查看内部所有视频的标题、作者和封面，已备份的视频自动高亮绿色。
- **🏷️ 自定义命名模板**：提供可视化标签编辑器，自由组合视频标题、UP主、BV号、日期等变量，实时预览文件名效果。
- **📋 双模任务日志**：精简模式显示中文人类可读摘要，原始模式显示完整终端输出，一键切换，实时流式推送。
- **🧪 三档任务日志**：精简 / 原始 / 调试三种模式；下载解析失败时会自动生成 debug 日志文件，便于定位 BBDown 细节问题。
- **🧠 v2.1.1 持续备份引擎**：收藏夹不再“必须全量扫完才开传”，发现新视频会即时入队下载/上传。
- **♻️ Docker 重启可恢复**：下载中/上传中任务状态持久化到 `data/state.json`，容器重启后自动续传与补传。
- **🩹 AList 慢修复机制**：已上传文件会周期抽样校验，发现 AList 丢文件后自动回补（视频仍可访问时）。
- **🧾 每轮摘要日志**：即使本轮无新增视频，也会输出“无新增 + 远端核验统计”日志，便于确认任务不是卡住。
- **🔍 手动全量对账**：新增 `Full Reconcile` 按钮，可手动触发一次全量远端核验并对缺失文件重新入队回补。

## 🚀 快速开始（Docker）

### 方式一：直接拉取镜像部署（推荐）

如果你不想在本地编译代码，可以直接新建一个 `docker-compose.yml` 文件，填入以下内容：

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASS=admin
      - SESSION_SECRET=change-me
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
      - ./alist:/app/alist:ro
    depends_on:
      - alist

  alist:
    image: xhofe/alist:latest
    container_name: bili-favorites-backup-alist
    restart: always
    volumes:
      - ./alist:/opt/alist/data
    ports:
      - "5244:5244"
    environment:
      - PUID=0
      - PGID=0
      - UMASK=022
      - ALIST_ADMIN_PASSWORD=admin123  # 这里是你的 AList 初始管理员密码
```

然后执行：
```bash
docker compose up -d
```

### 方式二：克隆源码本地编译构建

如果你修改了源码或者想用最新未经推送的代码：

```bash
docker compose up -d --build
```

### 方式三：接入已有的 AList（无需部署内置 AList）

如果你在别的服务器上（或者本机其他地方）**已经部署过 AList**，你可以完全不需要让本程序再跑一个 AList。
直接使用极其精简的 `docker-compose.yml` 即可：

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASS=admin
      - SESSION_SECRET=change-me
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
```

部署完成后，在我们的 Web 面板里，把"AList 内部通信地址"填成你**已有 AList 的公网/局域网地址**（例如 `http://192.168.1.100:5244`），再填上你的账号密码，系统就能无缝对接到你现有的 AList 里！

> **注意**：此方式下，任务日志控制台仍然正常工作（显示下载进度、上传进度等），因为日志来自本程序自身的 BBDown 下载和 WebDAV 上传过程，与 AList 容器无关。

### 日常更新

如果拉取了新代码，请使用以下命令重启并重新构建镜像：

```bash
docker compose down
docker compose up -d --build
```

### 进入面板

- 主控制面板：http://localhost:3000
- AList 管理后台：http://localhost:5244（仅方式一/二）

默认管理员登录：`admin / admin`（强烈建议在 docker-compose 中修改环境变量 `ADMIN_USER` 和 `ADMIN_PASS`）。

## ⚙️ AList 网盘挂载指南

本系统使用 AList 的 WebDAV 接口进行原生上传。
1. 访问 AList 面板（默认 http://localhost:5244 ），使用初始默认账号 `admin` 和密码 `admin123` 登录（你可以在 docker-compose 的 `ALIST_ADMIN_PASSWORD` 中修改此初始密码）。
2. 在 AList 的【存储】页面中添加你的目标网盘（例如阿里云盘，挂载路径设为 `/阿里云盘`）。
3. 回到主控制面板的 **[全局设置]**，将 AList 目标存储路径设置为 `/阿里云盘/bili-backup/videos`。系统便会自动将下载好的视频推送到你的网盘！

## 🔁 v2.1.1 备份策略说明

- **持续扫描，而非一次性扫完**：每轮会先扫前几页热点内容，再逐步补扫历史页；新收藏会更快进入备份流程。
- **新增/删除收藏都可兼容**：即使视频被取消收藏，也不会删除历史备份记录；下架视频仍会保留状态。
- **“上传了但失效”的视频优先有价值**：下架视频会在状态中区分是否已备份，便于后续筛选与核对。
- **远端不再盲信**：已备份视频会进行远端存在性校验；若 AList 侧文件缺失，会自动重新排队补传。
- **手动全量回查**：可点击 `Full Reconcile` 强制执行一次“全量远端核验 + 缺失回补入队”，用于人工对账或批量修复后确认。
- **远端校验覆盖增强**：带 `remotePath` 的历史视频也会被纳入回查，不再只检查带 `remoteFiles` 的新记录。
- **风控冷却机制**：遇到 B 站风控/登录异常时，账号进入冷却窗口，减少持续重试触发更严风控。
- **失败任务下轮直入队列**：下载/上传失败标记会在下一轮同步开始前优先回补入队，不再依赖再次翻页命中。
- **同步按钮支持排队**：同步运行中再次点“立即同步/对账”会排队到下一轮执行，不会静默失败。

## 🐳 Docker 运行建议（v2.1.1）

- 请**持久化挂载** `./data:/app/data` 与 `./temp:/app/temp`，否则容器更新后会丢失任务状态与恢复能力。
- 更新镜像建议继续使用：

```bash
docker compose down
docker compose up -d --build
```

- 若你是拉取远端镜像部署，可改为：

```bash
docker compose pull
docker compose up -d
```

- 建议不要手动删除 `data/state.json`；该文件用于续传、下架状态和补传决策。

## 🎛️ Web 面板功能一览

所有配置均在 Web 面板在线修改并实时生效，无需手写 JSON：

- **基础轮询**：设定自动检测新收藏视频的时间间隔（分钟）。
- **云盘目录映射**：提供三种整理模式：
  - `用户名 / 收藏夹名 / 视频`
  - `收藏夹名 / 视频`
  - `仅视频文件`
- **下载与上传并发**：独立设置下载和上传的同时进行数量（为防止风控，建议下载并发保持为 1）。
- **手动全量对账**：账号卡片区 `Full Reconcile` 按钮会触发 `/api/sync/reconcile`，用于整库核验远端并回补缺失文件。
- **视频高级参数**：自由选择是否需要 8K 画质和全景杜比音效。
  - 勾选 Hi-Res / 杜比后会并入 BBDown 的 `--dfn-priority`，不仅启用 APP 鉴权，也会参与实际流选择优先级。
- **📁 收藏夹可视化浏览**：选择收藏夹时带封面缩略图，点击"查看详情"可展开浏览所有视频的标题、UP主和封面图。已备份的视频会自动高亮为绿色并显示 `✓ 已备份` 徽章。
- **🏷️ 自定义命名模板**：可视化变量标签（视频标题、UP主、BV号、发布日期、清晰度、编码），点击拼接，实时预览。也支持手动编辑高级 BBDown 模板语法。
- **📋 双模任务日志**：
- **📋 三模任务日志**：
  - **精简模式**（默认）：中文人类可读摘要，如 `09:01:18 正在下载《XXX》1080P HEVC`
  - **原始输出**：BBDown 和上传引擎的完整终端输出
  - **调试模式**：聚焦错误/警告和 debug 线索（含 debug 文件保存位置）
  - 基于 SSE 实时流式推送，无需刷新页面

### 调试日志落盘

- 当出现 `解析此分P失败` 时，系统会自动执行一次 BBDown 调试探测并将结果保存到：
  - `data/debug/*.log`
- 网页“调试模式”日志会展示对应文件路径。
- 常规任务日志会持久化到：
  - `data/logs.json`

## 🔧 本地开发

本系统基于 Node.js 环境开发：

```bash
npm install
npm run dev
```

## ⚠️ 常见问题

**1. 下载被限速或拦截**
高频下载极易触发 B 站安全风控，请适当调大 **失败重试间隔** 以及 **视频间延迟时间**。系统内部使用了任务队列，遇到网络截断会自动将该任务送入等待队列稍后重试，不会影响其他账号的工作。

**2. 收藏夹封面图不显示**
B 站的封面图可能存在防盗链，系统已添加 `referrerpolicy="no-referrer"` 绕过。如果仍然无法加载，可能是网络环境导致的。

## 💖 鸣谢

- biliAPI: https://github.com/renmu123/biliAPI
- BBDown: https://github.com/nilaoda/BBDown
- AList: https://alist.nn.ci/
- Bilibili API Collect: https://socialsisteryi.github.io/bilibili-API-collect/
