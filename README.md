# Bili-favorites-backup

## 最近更新：v2.4.0

- 备份状态与任务队列迁移到 SQLite，旧 `state.json` 首次启动自动校验导入，崩溃或重启后按租约继续执行。
- AList 上传增加准确文件大小、两阶段远端确认、故障熔断和缓存背压；失败文件保留本地并优先补传。
- BBDown 升级到固定 fork Release `bfb-2.0.0`，通过 aria2 续传，并按分P CID复用成品和归档历史版本。
- 下载接口支持“网页 / APP”模式，网页风控自动冷却探测，APP空播放信息仅为当前视频回退网页一次。
- 运行时升级到 Node.js 24，容器固定BBDown与FFmpeg构建并缩减镜像体积。

一个全自动化 Node.js 服务：定时监控 Bilibili 收藏夹，使用 BBDown 高清下载，并通过 AList 直连 WebDAV 自动同步归档到各类国内网盘（如阿里云盘、夸克、百度网盘、115等）。

## ✨ 核心特性

- **🟢 纯粹的 Miku 绿清新主题**：焕然一新的现代化 Web UI，全平台自适应，极具质感。
- **📺 稳定 TV 端登录**：采用 Bilibili TV 端 API 进行扫码登录，有效绕过 Web 端的严苛风控限制。
- **⚡ 持久化任务队列**：SQLite 原子领取、唯一去重、延迟重试和租约恢复，缓存背压解除后自动继续，内存中只保留少量正在执行的任务。
- **🎞️ 深度定制 BBDown**：网页端直观选择网页/APP播放接口、视频编码 (HEVC/AVC/AV1)、强制画质 (4K/8K)、以及下载 Hi-Res 和杜比音效；APP 模式要求所有启用账号具有扫码登录 token。
- **☁️ AList 极简挂载体验**：彻底告别繁琐的命令行配置，自带 AList 面板，全中文可视化挂载你的任意网盘。也可以直接接入你已有的 AList。
- **🧯 上传故障保护**：AList 认证、驱动或网络持续异常时自动暂停新下载；实际 WebDAV PUT 默认全局间隔 10 秒，单个确定性失败会隔离补传而不阻塞全局，已下载文件不会因上传失败被删除；同名异大小的旧成品会整组归档到远端 `_history` 后再补传当前版本。
- **📦 Docker 一键部署**：开箱即用，所有配置皆可通过前端 Web 面板热重载生效。
- **🖼️ 可视化收藏夹浏览**：收藏夹带封面缩略图展示，点击可展开查看内部所有视频的标题、作者和封面，已备份的视频自动高亮绿色。
- **🏷️ 自定义命名模板**：提供可视化标签编辑器，自由组合视频标题、UP主、BV号、日期等变量，实时预览文件名效果。
- **📋 四档任务日志**：队列看板 / 精简模式 / 原始输出 / 调试模式可切换；队列看板会展示待下载、下载中、待上传、上传中。
- **🧪 调试日志落盘**：下载解析失败时会自动生成 debug 日志文件，便于定位 BBDown 细节问题。
- **🧠 持续备份引擎**：收藏夹不再“必须全量扫完才开传”，发现新视频会即时入队下载/上传。
- **♻️ Docker 重启可恢复**：下载会话、分P CID 和已验证成品会持久化；aria2继续未完成字节，上传失败继续补传，不会从头清空整个 BV 目录。
- **🔋 充电视频低频复查**：接口明确确认充电专属且当前无权限时显示“充电视频”，不再反复启动BBDown；系统每7天检查全部启用账号，任一账号获得完整权限后自动恢复下载。
- **🗂️ 新旧分P分离**：恢复时以 B 站当前版本为正式备份，被替换或删除的完整旧分P保存到远端 `_history`；只能抢救到部分内容时明确显示“部分备份”。
- **🚦 有界启动恢复**：大量历史任务保存在 SQLite 中，启动时只按队列高水位领取，避免一次性创建上千个内存任务。
- **🩹 AList 慢修复机制**：已上传文件会周期抽样校验，发现 AList 丢文件后自动回补（视频仍可访问时）。
- **🧾 每轮摘要日志**：即使本轮无新增视频，也会输出“无新增 + 远端核验统计”日志，便于确认任务不是卡住。
- **🔍 手动对账**：提供“状态对账（仅 AList）”和“全量扫描并对账”；后者会扫描 B 站收藏夹并带二次确认。
- **🛡️ 统一确认弹窗**：高风险操作使用站内确认流程，Cookie 导出还需要输入 `EXPORT_COOKIE`。
- **🧳 数据迁移包**：schema 3提供轻量与完整两种模式；完整模式会额外携带`temp`下载会话、aria2断点、待补传文件和历史分P，并使用流式ZIP64、逐文件校验、导入前自检备份和原子回滚。BBDown临时凭据不会进入迁移包，旧schema 1/2包仍可导入。
- **🧷 更稳的详情列表**：长标题、长 UP 主或长 BV 信息会自动省略，状态徽章不再被挤出列表。

## 🚀 快速开始（Docker）

### 方式一：直接拉取镜像部署（推荐）

如果你不想在本地编译代码，可以直接新建一个 `docker-compose.yml` 文件，填入以下内容：

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=${ADMIN_USER:-admin}
      - ADMIN_PASS=${ADMIN_PASS:-please-change-admin-pass}
      - SESSION_SECRET=${SESSION_SECRET:-please-change-session-secret}
      - ALLOW_COOKIE_EXPORT=${ALLOW_COOKIE_EXPORT:-true}
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
      - ./alist:/app/alist:ro
    depends_on:
      - alist

  alist:
    image: xhofe/alist:v3.61.0
    container_name: bili-favorites-backup-alist
    restart: unless-stopped
    volumes:
      - ./alist:/opt/alist/data
    ports:
      - "5244:5244"
    environment:
      - PUID=0
      - PGID=0
      - UMASK=022
      - ALIST_ADMIN_PASSWORD=${ALIST_ADMIN_PASSWORD:-please-change-alist-pass}
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
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=${ADMIN_USER:-admin}
      - ADMIN_PASS=${ADMIN_PASS:-please-change-admin-pass}
      - SESSION_SECRET=${SESSION_SECRET:-please-change-session-secret}
      - ALLOW_COOKIE_EXPORT=${ALLOW_COOKIE_EXPORT:-true}
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
```

部署完成后，在我们的 Web 面板里，把"AList 内部通信地址"填成你**已有 AList 的公网/局域网地址**（例如 `http://192.168.1.100:5244`），再填上你的账号密码，系统就能无缝对接到你现有的 AList 里！

> **注意**：此方式下，任务日志控制台仍然正常工作（显示下载进度、上传进度等），因为日志来自本程序自身的 BBDown 下载和 WebDAV 上传过程，与 AList 容器无关。

### 镜像标签

- `minori0721/bili-favorites-backup:latest`：稳定版，对应 `main` 分支。
- `minori0721/bili-favorites-backup:dev`：测试版，对应 `dev` 分支，可通过 `docker compose pull && docker compose up -d` 更新到最新 dev。
- `v*.*.*` 版本标签会发布对应版本镜像。

正式版本变更见 [CHANGELOG.md](CHANGELOG.md)。

### 日常更新

如果拉取了新代码，请使用以下命令重启并重新构建镜像：

```bash
docker compose down
docker compose up -d --build
```

### 进入面板

- 主控制面板：http://localhost:3000
- AList 管理后台：http://localhost:5244（仅方式一/二）

默认管理员用户名仍是 `admin`；请在 docker-compose 中修改 `ADMIN_PASS` 和 `SESSION_SECRET`。登录接口按客户端IP限制为15分钟内最多5次失败，成功登录不计数。使用HTTPS反向代理时请设置 `COOKIE_SECURE=true`；如不需要网页导出B站Cookie，请设置 `ALLOW_COOKIE_EXPORT=false`。程序启动时会提示这些弱配置，但不会打印实际密码、密钥或Cookie。

## ⚙️ AList 网盘挂载指南

本系统使用 AList 的 WebDAV 接口进行原生上传。
1. 访问 AList 面板（默认 http://localhost:5244 ），使用账号 `admin` 和 docker-compose 中 `ALIST_ADMIN_PASSWORD` 指定的初始密码登录。
2. 在 AList 的【存储】页面中添加你的目标网盘（例如阿里云盘，挂载路径设为 `/阿里云盘`）。
3. 回到主控制面板的 **[全局设置]**，将 AList 目标存储路径设置为 `/阿里云盘/bili-backup/videos`。系统便会自动将下载好的视频推送到你的网盘！

## 🔁 持续备份策略说明

- **持续扫描，而非一次性扫完**：每轮会先扫前几页热点内容，再逐步补扫历史页；新收藏会更快进入备份流程。
- **新增/删除收藏都可兼容**：即使视频被取消收藏，也不会删除历史备份记录；下架视频仍会保留状态。
- **“上传了但失效”的视频优先有价值**：下架视频会在状态中区分是否已备份，便于后续筛选与核对。
- **自投稿失效可回填**：如果视频对当前账号本人仍可见，系统会优先回填真实标题、UP 主、封面和简介，继续纳入正常备份；普通失效视频仍按失效项处理。
- **远端不再盲信**：已备份视频会进行远端存在性校验；若 AList 侧文件缺失，会自动重新排队补传。
- **状态对账（仅 AList）**：只读取 AList 侧现有文件并同步本地状态，不主动全量扫 B 站收藏夹。
- **全量扫描并对账**：完整扫描所选 B 站收藏夹并核验 AList 状态，适合初始化或人工强制核查，触发前会有风险确认。
- **远端校验覆盖增强**：带 `remotePath` 的历史视频也会被纳入回查，不再只检查带 `remoteFiles` 的新记录。
- **风控冷却机制**：遇到 B 站风控/登录异常时，账号进入冷却窗口，减少持续重试触发更严风控。
- **充电权限检查**：以详情接口的`is_upower_exclusive`和`is_upower_play`为准；试看不算完整备份。无权限时默认每`7天 ± 12小时`复查，临时接口错误约6小时后再查，账号重新登录或启用会立即唤醒检查。
- **失败任务优先恢复**：上传失败且本地文件仍在时标记为“待补传”，不会重新下载；单个不兼容文件会低优先级隔离重试，其他失败任务按全局补传预算逐批恢复。
- **上传节奏与临时会话恢复**：设置中的“AList 文件上传间隔”只限制真实 PUT 的全局启动频率，远端预检命中不等待；同一任务已有文件完成后再遇到 405 时按临时会话异常在 5、10、30 分钟后补传，首文件直接 405 仍按确定性驱动错误处理。
- **两阶段上传确认**：PUT 返回成功后先进入“已上传·确认中”；远端延迟可见的 404 不触发熔断，大小一致后才最终确认并清理本地文件。
- **同步按钮支持排队**：同步运行中再次点“立即同步/对账”会排队到下一轮执行，不会静默失败。
- **顺序展示**：收藏夹详情优先按 B 站收藏夹接口返回的页码与页内位置排序，方便对照原收藏夹。

## 🐳 Docker 运行建议

- 请**持久化挂载** `./data:/app/data` 与 `./temp:/app/temp`，否则容器更新后会丢失任务状态与恢复能力。
- 推荐为 app 和 AList 都设置 `restart: unless-stopped`，异常退出或宿主机重启后会自动拉起；如果你手动停止容器，它不会反复自启。
- Web 面板的「清理数据」会区分全部临时目录和已标记的待清理残片；可恢复会话与有效旧成品不会被残片清理误删，重要数据仍需二次确认。
- Web 面板的「数据迁移」可导出轻量或完整zip迁移包；完整导出要求当前没有运行任务，完整导入要求目标`temp`为空。导入前自动备份与普通导出使用同一SHA256清单并先完成自检，配置、账号、日志或SQLite校验失败不会切换现有数据。包含账号登录信息时，压缩包中会带B站Cookie/token，请当作敏感文件保管。
- BBDown运行凭据只写入系统临时目录，启动和正常关闭时会清理遗留目录；迁移导出和导入会排除历史凭据目录。不要把系统临时目录或原始日志作为公开诊断包上传。
- 内置Compose固定使用AList `v3.61.0`。升级已有AList前请先备份其数据目录；升级后至少验证WebDAV的PUT、MOVE、列出、下载和删除。外接AList不会由本应用自动升级。
- 「清理数据」只处理本项目 app 侧的 `data` 与 `temp`，不会删除 AList 的 `alist` 目录；如果要连 AList 数据一起清掉，请停容器后手动删除宿主机上的 `alist` 目录。
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

- 不要在程序运行时手动删除 `data/bfb.sqlite`、`data/bfb.sqlite-wal` 或 `data/bfb.sqlite-shm`。需要清空状态请使用网页“清理数据”；旧 `state.json` 迁移备份位于 `data/backups`。

## 🎛️ Web 面板功能一览

所有配置均在 Web 面板在线修改并实时生效，无需手写 JSON：

- **基础轮询**：设定自动检测新收藏视频的时间间隔（分钟）。
- **云盘目录映射**：提供三种整理模式：
  - `用户名 / 收藏夹名 / 视频`
  - `收藏夹名 / 视频`
  - `仅视频文件`
- **下载与上传并发**：独立设置下载和上传的同时进行数量（为防止风控，建议下载并发保持为 1）；上传流可以并发，但实际 WebDAV PUT 的启动时间受全局上传间隔控制；本地缓存软上限默认 10GB，超限时只暂停启动新下载，上传和上传后清理继续运行。
- **BBDown 播放接口**：默认使用网页接口；也可以让所有新任务优先使用 APP 接口。网页接口遇到 `v_voucher` 后会全局冷却 3 分钟；APP 返回空播放信息时仅当前视频回退 Web 一次，不会永久修改全局设置或循环切换。
- **手动对账**：账号卡片区“状态对账（仅 AList）”会只核验远端文件；“全量扫描并对账”会同时扫描 B 站收藏夹和 AList。
- **危险操作确认**：删除账号、导出 Cookie、全量扫描、旧命名重命名和画质重调都使用站内确认弹窗；取消不会调用对应接口。
- **账号删除**：删除登录凭据前会停止依赖该账号的下载；完整本地成品直接转为原目标补传，未完成会话只替换为其他启用账号的下载凭据。没有替代账号时任务持久暂停，同UID重新扫码后恢复，已确认备份、下架资料和远端证明继续保留。
- **旧命名重命名**：只使用归档时保存的真实日期、分P、画质和编码；缺少资料时会跳过。执行前会复查源/目标，失败后返回已完成、已回滚、临时名滞留、冲突或缺失的实际状态。
- **画质重调**：无法判断旧文件画质的项目单独列出且默认不选；同一BVID相同目标档案复用已验证下载成品。旧备份DELETE失败时保留新版与本地文件，并显示“旧文件清理重试中”直到远端清理成功。
- **视频高级参数**：自由选择是否需要 8K 画质、Hi-Res 音质和全景杜比音效。
  - Hi-Res / 杜比会自动切换到 APP 接口，并通过 BBDown 的 `--encoding-priority` 优先选择对应音频流；清晰度通过 `--dfn-priority` 控制。
- **📁 收藏夹可视化浏览**：选择收藏夹时带封面缩略图，点击"查看详情"可展开浏览所有视频的标题、UP主和封面图。已备份的视频会自动高亮为绿色并显示 `✓ 已备份` 徽章。
- **🏷️ 自定义命名模板**：可视化变量标签（视频标题、UP主、BV号、发布日期、清晰度、编码），点击拼接，实时预览。也支持手动编辑高级 BBDown 模板语法。
- **📋 四档任务日志**：
  - **队列看板**：按待下载、下载中、待上传、上传中展示当前任务队列
  - **精简模式**（默认）：中文人类可读摘要，如 `09:01:18 正在下载《XXX》1080P HEVC`
  - **原始输出**：BBDown 和上传引擎的完整终端输出
  - **调试模式**：聚焦错误/警告和 debug 线索（含 debug 文件保存位置）
  - 基于 SSE 实时流式推送，无需刷新页面

### 调试日志落盘

- 当出现 `解析此分P失败` 时，系统会自动执行一次 BBDown 调试探测并将结果保存到：
  - `data/debug/*.log`
- `v_voucher` 风控信号不会保存完整播放响应或重复执行调试探测，而是进入 3 分钟冷却和单任务恢复流程。
- `APP_NO_VIDEO_INFO` 信号不会按“视频失效”落库或重复执行 APP；当前任务会直接用 Web 再解析一次。
- 网页“调试模式”日志会展示对应文件路径。
- 常规任务日志会持久化到：
  - `data/logs.json`
- 历史日志、实时SSE和队列错误共用同一脱敏器；Authorization、Cookie、token、CSRF及URL凭据会在写盘和推送前清除。诊断日志仍可能包含文件路径、BV号等运行上下文，公开前请人工复核。

## 🔧 本地开发

本系统基于 Node.js 24 环境开发：

```bash
npm install
npm run dev
```

如需回滚到仍读取 `state.json` 的旧镜像，可先离线导出兼容快照：

```bash
npm run state:export-json -- data/bfb.sqlite data/state.rollback.json
```

请在当前程序停止后执行回滚，并把确认过的输出文件改为旧镜像需要的 `data/state.json`。

## ⚠️ 常见问题

**1. 下载被限速或拦截**
高频下载极易触发 B 站安全风控，请适当调大 **失败重试间隔** 以及 **视频间延迟时间**。系统内部使用了任务队列，遇到网络截断会自动将该任务送入等待队列稍后重试，不会影响其他账号的工作。

**2. 收藏夹封面图不显示**
B 站的封面图可能存在防盗链，系统已添加 `referrerpolicy="no-referrer"` 绕过。如果仍然无法加载，可能是网络环境导致的。

## 💖 鸣谢

- biliAPI: https://github.com/renmu123/biliAPI
- BBDown: https://github.com/nilaoda/BBDown
- FFmpeg: https://ffmpeg.org/
- Linux FFmpeg build: https://github.com/BtbN/FFmpeg-Builds
- AList: https://alist.nn.ci/
- Bilibili API Collect: https://socialsisteryi.github.io/bilibili-API-collect/
