# 更新日志 (Changelog)

## [2.1.3] - 2026-05-10

### 新增

- 新增 `状态对账（仅AList）` 入口（`POST /api/sync/reconcile-remote`）：只执行远端文件状态核验与缺失回补入队，不扫描 B 站收藏夹。
- 新增高风险二次确认：执行 `全量扫描并对账` 前弹窗提示风控风险，避免误触发。

### 调整

- `全量扫描并对账`（`POST /api/sync/reconcile`）语义调整为严格全量：先全页扫描已选收藏夹，再执行远端全量核验。
- 同步触发按钮文案与状态提示统一为中文（含进行中/已触发状态）。
- `runNow` / `runReconcileNow` / `runRemoteReconcileNow` 在任务运行中统一返回 `409`，避免前端误判触发成功。

### 修复

- 修复远端核验全量模式类型问题：`listVideosForRemoteVerify` 支持不限量拉取。
- 修复 Hi-Res / 杜比参数仅启用 app 模式但未参与清晰度优先级的问题：勾选项会并入 `--dfn-priority`。
- 修复远端状态回查覆盖不足问题：`uploaded/verified` 且存在 `remotePath` 的历史视频会纳入核验，不再仅依赖 `remoteFiles`。
- 修复 AList 文件删除后补偿触发不稳定问题：远端目录为空或缺失时进入缺失计数并自动尝试回补（视频仍可访问时）。
- 修复“无新增视频”场景缺少周期性摘要日志的问题：每轮同步结束均输出核验/缺失/耗时信息。

## [2.1.0] - 2026-05-10

### 🚀 持续备份架构升级

- **增量优先 + 历史补扫**：调度器改为“热点前页快速扫描 + 历史页渐进补扫”，不再必须全收藏夹扫完才开始上传。
- **即时入队**：新发现可备份视频会立即进入下载/上传队列，显著降低“新增后等待很久才备份”的窗口。
- **收藏变化兼容**：支持收藏夹中途新增/删除场景，取消收藏不会删除历史备份状态与归档记录。

### 🧱 状态模型重构（state v2）

- `state.json` 新增 `videos / relations / folderScans / userCooldowns` 结构，支持视频级生命周期追踪：
  - `discovered -> queued -> downloading -> downloaded -> uploading -> uploaded/verified`
  - `missing / lost / failed` 异常状态
- 新增历史兼容迁移逻辑：旧版 `processedByUser / failedByUser` 启动后自动迁移到新结构。
- 下架视频状态可区分“已备份下架”和“未备份下架”，用于后续优先级判断。

### ♻️ Docker 重启恢复与补传

- 启动时自动恢复未完成任务（下载后待上传、上传中断、缺失待补）。
- 任务生命周期状态实时持久化，容器重启/镜像更新后可续跑。
- 对已上传文件增加远端抽样校验，发现 AList 丢文件会自动回补（视频仍可访问时）。

### 🛡️ 风控稳定性增强

- 引入账号级冷却窗口：触发 B 站风控/登录异常时暂停该账号轮询一段时间，避免连续重试放大风险。
- 修复 `accessToken` 混入 Cookie 的问题，`accessToken` 改为独立传参，减少异常请求特征。

### 🔌 API 行为更新

- `/api/users/:id/unavailable` 改为基于本地状态游标分页，不再每次请求都实时全链路扫 B 站接口。
- `/api/state` 新增 `cooldowns`，可用于观察当前账号冷却状态。

### 🧩 任务与上传链路增强

- `DownloadTask` / `UploadTask` 增加生命周期 hook，状态更新更准确。
- AList 上传返回远端文件清单，供后续校验与补传策略使用。

### 📌 版本信息

- `package.json` 版本升级至 `v2.1.0`。

## [1.0.3] - 2026-05-09

### 🐛 关键修复

#### 修复 accessToken 污染 Cookie header
- **bili.ts**: `createBiliClient()` 解构剔除 `accessToken`，仅将 `SESSDATA` / `bili_jct` / `DedeUserID` 写入 Cookie 字符串
- **bili.ts**: `accessToken` 改为通过 `Auth.setAuth()` 第三个参数独立传入，不再污染 Cookie header

#### 修复 B 站 API `code` 检查丢失
- **bili.ts**: `listFavoriteItemsPage()` 使用 `extra: { rawResponse: true }` 获取完整 B 站 JSON 响应 (`{code, message, data}`)
- **bili.ts**: 显式检查 `code !== 0`，`-101` / `-111` 等鉴权失败码转为 `BiliRiskOrLoginError`

#### 完善风控状态码覆盖
- **bili.ts**: 新增 `403` / `509` 状态码识别
- **bili.ts**: 正则匹配「风控」「安全验证」关键词，减少漏报

#### 修复 WBI 签名算法
- **bili.ts**: `mixinKey` 重写为逐字符拼接（对照 biliAPI 源码 `getMixinKey`），修复 `codePointAt → string` 类型错误
- **bili.ts**: `encWbi` 补全 `!'()*` 字符过滤，与 biliAPI 签名协议一致
- **bili.ts**: WBI key 获取 URL 改为 `x/web-interface/nav`（此前使用错误的 `wbi/index/nav`）

#### WBI Key 缓存优化
- **bili.ts**: 实现内存 + 文件持久化缓存（`data/.wbi-keys.json`），进程生命周期内复用 WBI key，不再每次请求独立获取

### ⚡ 性能
- 每次轮询不再重复拉取 WBI key（减少 1-N 次额外 HTTP 请求）

## [1.0.2] - 2026-05-09

### 🐛 关键修复

#### 修复「request was banned」错误
- **bili.ts**: `listFavoriteItemsPage()` 从原生 `fetch()` 改为使用 biliAPI 库的请求基础设施
- **bili.ts**: 所有请求参数通过 `utils.WbiSign()` 进行 WBI 签名，添加 `w_rid` + `wts` 参数
- **bili.ts**: 请求自动携带完整 Cookie（含真实 buvid3/buvid4）、User-Agent、dm_cover_img_str 等风控参数
- **bili.ts**: 提取公共 `createBiliClient()` 工厂函数，消除 `getUserInfo`/`listFavoriteFolders`/`listFavoriteItemsPage` 中的重复代码

#### 修复「同步到一半卡住」问题
- **bili.ts**: `listFavoriteItems()` 新增指数退避重试机制，每页最多重试 3 次（1s → 2s → 4s，上限 10s）
- **bili.ts**: 风控/登录失效错误（`BiliRiskOrLoginError`）立即向上抛出，不做无意义重试
- **bili.ts**: 普通网络错误重试耗尽后跳过当前页继续后续页，不再丢弃整个收藏夹的剩余视频
- **bili.ts**: 控制台输出清晰的重试/跳过警告日志，方便排查问题

#### 接口签名统一
- **scheduler.ts**: `listFavoriteItems()` 调用改为直接传入 `BiliCookie` 对象，移除中间 `buildCookieString()` 转换
- **index.ts**: 两处 `listFavoriteItemsPage()` 调用同步改为传入 `BiliCookie` 对象
- **scheduler.ts**, **index.ts**: 移除不再需要的 `buildCookieString` 导入

## [1.0.1] - 2026-05-08

### 🐛 核心修复与优化
- **核心逻辑**：修复了因冗余路由与阻塞同步（`await scheduler.tick()`）导致的前端点击“立即同步”无响应、接口无限转圈的恶性 bug。
- **日志重构**：优化并精简了任务日志输出流，去除了由于未匹配解析而重复输出的原始数据，精简模式现已十分纯净。
- **UI 增强**：加入了全局错误捕获机制，新增右下角优雅的 Toast 气泡动画弹窗，发生网络请求失败时不再是静默报错。
- **底层清理**：优化 Dockerfile 构建脚本，彻底移除不再使用的 `rclone` 依赖，完全转向更轻量的原生 WebDAV，显著减小镜像体积并加快构建速度。
- **工程规范**：规范化了后台下载与上传队列的任务类型约束，增加 `userId` 与 `mediaId` 等核心属性的强校验，消除隐式的 `any` 危险断言。
- **跨平台兼容**：全量扫描并统一了项目内所有 TS 源码的换行符为 `LF`（修复了混用 `CRLF` 导致的潜在环境问题）。

## [1.0.0] - 2026-05-08

### ✨ 新增功能

#### 分页加载与优化
- **bili.ts**: 新增 `listFavoriteItemsPage()` 函数支持单页拉取收藏夹视频
- **bili.ts**: 添加 `BiliRiskOrLoginError` 异常类，区分风控/登录失效错误
- **bili.ts**: 多页拉取时加入 300ms 节流延迟，避免 B 站 API 限流
- **web.ts**: 收藏夹详情弹窗改为分页滚动加载，支持大收藏夹浏览
- **web.ts**: 下架清单支持分页游标遍历多个收藏夹

#### 后端 API 增强
- **index.ts**: `/api/users/:id/favorites/:mediaId/items` 改为分页返回，新增 60 秒缓存
- **index.ts**: `/api/users/:id/unavailable` 支持游标分页，逐页扫描下架视频
- **index.ts**: 登录时自动保存 `accessToken`，供 Hi-Res/杜比音效下载使用
- **index.ts**: 新增 `/api/state` 端点，返回已处理和失败视频的状态
- **index.ts**: 新增 `/api/cache/clear` 端点，支持手动清除收藏夹详情缓存
- **index.ts**: 日志流式传输 `/api/logs/stream` (Server-Sent Events)

#### 下载控制增强
- **downloader.ts**: BBDown 画质参数规范化（8K、4K、1080P 等）
- **downloader.ts**: BBDown 编码参数标准化（HEVC、AVC、AV1）
- **downloader.ts**: Hi-Res/杜比音效下载时需要 APP access token，避免失败
- **downloader.ts**: `perVideoDelaySeconds` 改为传给 `--delay-per-page`，实现视频间节流
- **downloader.ts**: 永久失败识别（视频删除、下架、不可见等），跳过重试

#### 状态管理与重试
- **scheduler.ts**: 同步队列去重更完善，避免重复下载
- **scheduler.ts**: 跳过已失败的视频任务，不重复排队
- **scheduler.ts**: 永久失败写入 state.json，支持失败原因记录
- **state.ts**: 新增 `failedByUser` 字段，记录失败视频及原因
- **state.ts**: `markFailed()` 支持记录永久失败标记和失败描述

#### UI/UX 改进
- **web.ts**: 修复中文文案乱码，所有文本显示正常
- **web.ts**: 收藏夹详情显示视频缩略图、UP主、BV号
- **web.ts**: 下架清单支持筛选（未上传 / 已上传）
- **web.ts**: 日志支持"精简模式"和"原始输出"双模式切换
- **web.ts**: 一键重命名网盘文件功能
- **web.ts**: 模板标签拖拽排序，自定义视频命名格式

### 🔧 修复与改进

#### 代码质量
- **queue.ts**: Task 基类添加动态属性支持 (`[key: string]: any`)，避免 `as any` 类型转换
- **web.ts**: 数据验证加强，检查 `Array.isArray(data.items)` 防止异常结构
- **web.ts**: 错误处理改进，详细显示 API 错误信息
- **web.ts**: 乱码修复，将 `'δ֪'` 替换为 `'未知'`
- **index.ts**: accessToken 提前定义，避免 falsy 值检查失败
- **index.ts**: 游标验证加强，边界检查防止恶意输入（folderIndex、page < 10000）

#### 类型安全
- **bili.ts**: 完整的 TypeScript 类型定义（BiliUserInfo、FavoriteItem、FavoriteItemsPage 等）
- **index.ts**: 所有 API 端点的请求/响应类型明确
- **downloader.ts**: 编码/画质类型映射完善

### 📊 配置与性能

- **config.ts**: 支持视频间延迟、并发下载/上传配置
- **config.ts**: 支持任务重试次数和重试间隔调节
- **config.ts**: BBDown 编码/画质/Hi-Res/杜比选项完整支持
- **scheduler.ts**: 可配置的轮询间隔、并发数，支持热更新

### 🔐 安全性

- **bili.ts**: 风控/登录失效检测，区分处理不同错误
- **index.ts**: 游标输入验证，防止越界或恶意分页
- **users.ts**: Cookie 存储结构化，支持 accessToken 分离存储

### 📝 开发工具

- 完整 TypeScript 支持 (tsc 编译无错误)
- ESLint 配置 (eslint.config.mjs)
- 开发命令：`npm run dev`、`npm run build`、`npm start`
- 登录脚本：`npm run login`

### ⚡ 性能优化

- 300ms 多页拉取节流，避免 API 限流
- 60 秒收藏夹详情缓存，减少冗余请求
- Server-Sent Events 流式日志，减少轮询开销
- 前端分页虚拟滚动，大列表性能优化

### 📦 依赖清单

- **@renmu/bili-api**: 2.13.2（Bilibili API 客户端）
- **express**: 4.22.1（Web 框架）
- **express-session**: 1.19.0（会话管理）
- **qrcode**: 1.5.4（二维码生成）
- **webdav**: 5.10.0（WebDAV 协议）
- **typescript**: 5.9.3（类型检查）
- **tsx**: 4.21.0（TypeScript 执行）

### ⚠️ 已知限制

- `perVideoDelaySeconds` 当前实现为分 P 间延迟（`--delay-per-page`），若需严格视频级节流，需在队列层额外加延迟
- 依赖 @renmu/bili-api 中存在 XML 注入漏洞（不影响当前业务，可通过 `npm audit fix --force` 升级）

### 🔄 升级指南

#### 从之前版本升级：
1. 备份 `data/` 目录（用户数据、配置、状态）
2. 更新代码：`git pull origin main`
3. 安装依赖：`npm install`
4. 构建：`npm run build`
5. 启动：`npm start`

#### 配置迁移：
- 新字段自动补默认值，无需手动修改 config.json
- 旧的 state.json 兼容，自动扩展 `failedByUser` 字段

### 📞 反馈与贡献

欢迎提交 Issue 和 Pull Request。

---

**发布时间**: 2026-05-08  
**版本**: 1.0.0  
**状态**: 生产就绪 ✅
