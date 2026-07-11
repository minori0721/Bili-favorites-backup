# Dev 测试说明

本文只记录 `dev` 分支相对 `main` 的当前测试内容。确认稳定并合并到 `main` 时，把需要公开给用户的内容整理进 `CHANGELOG.md`，然后重置本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.3.3`
- 当前 dev 变更：SQLite 状态库、持久化任务队列、两阶段上传确认、Node.js 24、上传可靠性、BBDown/aria2续传、分P会话恢复、网页/APP接口模式、APP 空响应单任务回退和播放风控自动恢复，尚未合并到 `main`。
- 镜像预期：推送 `dev` 分支后发布 `minori0721/bili-favorites-backup:dev`；`latest` 仍只由 `main` 分支发布。

## 当前 dev 变更

- AList WebDAV 流上传显式发送准确 `Content-Length`、MIME、`X-OC-Mtime` 和 `X-OC-Ctime`，拒绝空文件/空目录；PUT 前同名同大小直接确认，PUT 后只立即检查一次，延迟可见交给持久化确认任务。
- 含 Emoji 等四字节字符的文件名仍优先按原名上传；仅原名出现确定性 400/405/422 时，才使用去除四字节字符的兼容名重试一次，并记录、校验实际远端文件名。正常支持 Emoji 的 AList 驱动不会被改名，兼容名与现有文件冲突时会自动追加稳定序号。
- 远端目录创建只忽略“并发创建后复查确实存在”，认证、权限、405、限流和驱动错误会继续向上传任务传播。
- 运行状态迁移到固定依赖 `better-sqlite3@12.11.1` 的 `data/bfb.sqlite`；启用 WAL、外键、5 秒 busy timeout 和 `synchronous=NORMAL`，迁移使用事务与 `PRAGMA user_version`。
- SQLite 表覆盖视频、收藏夹关系、下载会话、远端文件、任务、扫描、失败、冷却和画质重调；视频/关系大表按键懒加载，`StateManager` 保留兼容门面但不再长期持有完整状态对象。
- 视频汇总状态从 SQL 视图按关系状态优先级读取；仅在没有收藏夹关系时使用视频表中的兜底状态，避免全局状态覆盖关系级结果。
- 首次发现旧 schema 11 `state.json` 时先导入临时数据库，校验计数、外键和 `integrity_check` 后原子切换；原 JSON、SHA256 和迁移摘要永久保存到 `data/backups`。SQLite 已存在时禁止回退到旧 JSON。
- `jobs` 是下载、上传、上传确认、历史上传和画质重调的唯一持久来源；唯一键去重，事务领取，失败写回 `not_before`，租约过期后自动恢复。内存队列只保留高水位以内的已领取任务。
- 旧状态只在数据库首次缺少队列引导标记时幂等播种一次；完成后重启只恢复租约并领取现有 jobs，不再遍历状态重建已完成任务。旧 schema 1 JSON 覆盖导入会同时清空旧 jobs 与引导标记。
- 画质重调拆为持久化下载、暂存上传、远端替换和清理四个阶段；运行中断后从对应 job 与关系级操作记录恢复，不再依赖 `index.ts` 内存 Map。
- `startupRecoveryBatchSize`（默认 25，范围 5–100）现在控制内存领取高水位；本地待补传/已下载任务以更高优先级进入 SQLite，剩余任务不创建内存 backlog。
- “每轮最多补传数量”继续作为跨账号、跨收藏夹共享预算；数据库唯一索引代替恢复 Set，画质重调和普通任务共用硬容量队列。
- 上传错误统一分类、脱敏和限长；401/403 立即熔断，重复确定性错误和连续瞬时错误按阈值熔断，指数退避并支持 `Retry-After`，半开只放行一个本地上传探测。
- 单个文件的确定性错误不会继续占用优先补传锁：本地文件保持 `upload_failed`，转入约 6 小时后的低优先级隔离补传，其他下载和上传立即继续；多个任务出现相同错误时仍会触发全局熔断。
- 下载启动同时检查上传健康、优先补传、上传队列容量和缓存安全空间；缓存预留 `max(512 MiB, 上限的 10%)`，上传恢复后自动继续。
- `/api/queue/state` 增加 `uploadHealth`、`downloadApiHealth`、`recovery` 和 `localCache.reserveBytes`；页面仅在对应异常时显示上传或 B 站风控横条，保留原四列队列布局。
- PUT 返回 201/204 后文件进入 `awaiting_verification`，关系显示“已上传·确认中”并计入已上传筛选；按 2 秒、10 秒、30 秒、2 分钟、5 分钟、10 分钟确认，404 只视为可见性延迟。
- 10 分钟仍不可见时改回 `upload_failed` 并在 30 分钟后补传；补传前再次精确预检，同名同大小直接转为 `verified`。确认完成前保留本地文件、禁止画质重调和远端替换。
- 上传熔断、B站接口冷却和账号冷却统一保存在 `cooldowns`；上传熔断重启后继续生效，半开成功后自动清除并恢复下载。
- 数据迁移包升级为 schema 2：包含 SQLite 一致性备份、可读 `state.json` 快照和失效视频索引；schema 1 JSON 包自动导入数据库。`npm run state:export-json` 可生成旧镜像回滚快照。
- “清理备份状态”改为事务清空状态及任务表，数据库保持打开；空间统计包含 SQLite、WAL 和 SHM。
- BBDown 使用 fork Release `bfb-2.0.0`，源码提交 `fcb895f357df49c45010cefab773025d5d50cf7c`，Linux x64 zip SHA256 为 `9133c82ae482171ca777d69b850c4d5ed1ce93072e3b8d285c5f4e95749b629d`；Docker 不再安装 .NET SDK 或现场编译。
- FFmpeg 固定为 BtbN `n8.1.2-22-g94138f6973-20260711` Linux x64 LGPL 构建，归档到项目 Release `ffmpeg-bfb-8.1.2-20260711.1`，SHA256 为 `0102dad4a83b266f740a50db7cd5131a8e5266cde8f0937ec3f3cb4a8c3641fa`。运行镜像只通过 apt 安装 aria2 和证书，不再安装 Debian FFmpeg 的完整动态依赖树。
- fork 会把 Web 播放响应中的 `v_voucher` 转成 `BFB_SIGNAL:RISK_V_VOUCHER`，APP protobuf 缺少 `VideoInfo` 时输出 `BFB_SIGNAL:APP_NO_VIDEO_INFO`，成功取得播放流后输出 `BFB_SIGNAL:PLAYURL_READY:WEB|APP`；两类异常信号都不会进入 BBDown 内部重复解析。
- 全局设置新增“网页接口 / APP接口”：APP 模式新任务优先使用 `-app`，保存时要求所有启用账号具有 `accessToken`；Hi-Res / Dolby 自动切换 APP，后端拒绝 Web 与高级音频的矛盾配置。仅当 APP 返回空播放信息时，当前任务移除 `-app` 用 Web 重试一次，不修改全局模式、不重建下载会话，也不循环切换。
- Web 模式触发 voucher 后全局冷却固定 180 秒，原失败任务带 `notBefore` 高优先恢复；冷却后只允许一个任务探测，有 token 时临时用 APP，无 token 时继续 Web。收到 `PLAYURL_READY` 立即恢复，不等待整个视频下载完成。
- BBDown 新进程启动间隔固定随机 3–6 秒；已经取得地址并运行的 aria2 不会因新风控信号被终止。等待任务会采用新保存的接口模式，运行中任务不中途切换。
- 下载统一启用 aria2；`.bfb-download.json` 记录账号UID、配置指纹、分P CID、成品验证和历史分P，不保存 Cookie、Token 或签名URL。
- 下载不再开跑前删除 `temp/<BVID>`；只下载缺失分P，ffprobe 验证失败的混流成品移入 `_invalid`，普通断网保留 aria2数据；只有 416、长度变化或控制文件损坏才隔离当前音视频轨道。
- `bfb-1.6.3-259a5558.1` 升级到 `bfb-2.0.0` 只改变错误识别，不改变轨道格式；账号和运行参数不变时会更新会话提交号并保留现有 aria2/原始轨道，避免升级导致无意义重下。
- 当前分P以 CID 对账；分P重排会安全改名并复用相同 CID，新分P继续下载，被替换/删除的旧成品上传到 `_history/<快照时间>`，完全不可访问时可形成“部分备份”。
- 上传器使用显式文件白名单，不会上传会话清单、Debug JSON、aria2控制文件和 BBDown 原始轨道。
- 启动会自动接管没有清单的旧 BV 缓存；有效成品复用，旧封面导入 WebP 缓存，不可信残片只进入二次确认清理项；损坏清单会先保留副本再重建。
- 所有目标和历史文件上传完成后只删除已验证白名单成品；其他无法确认的内容写入待清理标记，不再随整个目录自动删除。
- SIGINT/SIGTERM 会停止调度并按进程树终止 BBDown/aria2，最多等待20秒，以便续传控制文件落盘。

## 测试重点

- WebDAV：准确长度、非 chunked、MIME/时间头、201/204、延迟可见、大小不一致、空文件/空目录、每次重试的新文件流，以及四字节文件名原名成功/兼容名回退/冲突避让。
- 错误处理：目录并发创建、401/403/405/429/500、超时/连接重置分类、`Retry-After`、脱敏和本地文件保留。
- 状态与恢复：schema 8→11、未完成会话继续下载、完整会话直接上传、部分备份、关系级部分失败、多目标完成后清理和下载接口冷却重启恢复。
- 下载会话：旧成品自动接管、CID替换与重排、配置变化隔离不兼容残片、损坏清单保留、嵌套命名模板、分P范围压缩、APP 空响应仅回退 Web 一次，以及 ffprobe 时长/流/快速哈希验证。
- 上传白名单：只上传清单成品，历史分P单独远端目录，Debug和控制文件不进入WebDAV。
- 压力场景：约 6 MiB、1000 条旧状态迁移后只领取 25 个内存任务；另构造 10000 个持久任务，原子领取仍限制为 25，剩余 9975 个只保存在 SQLite。
- SQLite：覆盖 JSON 自动迁移、重复启动、损坏 JSON/SQLite、外键损坏、永久归档、事务批处理、任务去重、优先级、`not_before`、租约恢复和状态清理。
- 两阶段确认：覆盖 PUT 后延迟可见、同名同大小跳过、大小冲突、确认跨重启、10 分钟超时、30 分钟补传、本地文件保留和熔断状态持久化。
- 应用回归：隔离目录登录、配置更新、`/api/queue/state`、清理状态、schema 2 导出导入、schema 1 导入和再次导出计数。
- 当前自动化结果（2026-07-11 复测）：Node.js `24.12.0` 下执行 `npm ci` 后，`npm test` 共 79 项，78 通过、0 失败；默认环境仅因未安装 aria2 跳过 1 项。随后临时使用官方 aria2 1.37.0 单独实跑该 Range 断线续传测试并通过，因此全部测试路径均已执行。`better-sqlite3` 原生模块加载、SQLite 内存库查询和 `npm run build` 均通过。
- Linux Actions 首轮失败定位为隔离上传测试 harness 写死 Windows 反斜杠路径；已统一改用 `path.join`，生产上传与调度逻辑没有发生变化。
- 内置浏览器：使用隔离数据检查桌面和 390×844。桌面四列宽约 241px；移动端页面宽 375px、视口 390px，无页面级横向溢出，四列只在队列容器内滚动。确认中条目与徽章完整落在容器内；BBDown 接口模式提示在桌面和移动端均正常换行，移动端提示容器宽约 313px；控制台无 warning/error。
- 隔离异常场景：本地模拟 AList 401 后显示“上传后端异常，下载已暂停”和下次探测时间，错误凭据已脱敏，正常/异常页面控制台均无错误。
- 服务器运行验证：`bili-favorites-dev` 已运行提交 `951effd` 和 BBDown `bfb-2.0.0`，启动后抽查下载 26/26、上传 28/28 完成，容器无重启、OOM、风控或 APP 空响应；SQLite `quick_check` 为 `ok`。
- FFmpeg 镜像优化验证（2026-07-12）：服务器隔离构建候选镜像，不替换或重启正式容器。Node.js 24、BBDown、aria2、`better-sqlite3`、FFmpeg/ffprobe、MP4+AAC、WebP 封面、应用启动及 SIGTERM 关闭均通过。镜像落盘由 `764MB` 降至 `577.4MB`，减少约 24.4%；`docker save | gzip -6` 估算由 `266.8MiB` 降至 `213.0MiB`，减少约 20.2%。
- GitHub Actions 固定 `ubuntu-24.04`，Actions、本地测试目标和 Docker 应用运行时统一为 Node.js 24；删除 QEMU 和重复 aria2 安装，增加 GHA Buildx 缓存，测试和 TypeScript 构建通过后才发布镜像。

## 建议测试命令

```bash
npm ci
npm test
npm run build
npm --prefix . audit --omit=dev
```

> 注意：`npm audit --omit=dev` 可能会报告依赖传递风险；自动修复前需要确认不会降级或破坏主依赖。

## 已知问题 / 暂缓项

- 本轮不连接真实 AList，因此尚未验证 189CloudPC、115、S3 等真实驱动的 PUT、列出、下载和删除；协议行为由本地模拟 WebDAV 覆盖。
- 版本保持 `2.3.3`，Node.js 运行时为 24；本轮只在服务器临时目录构建候选镜像验证体积与功能，没有替换正式容器。BBDown Native AOT 与 FFmpeg 均由固定 Release 提供并校验 SHA256，正式镜像仍由 GitHub Docker 工作流发布。
- `npm audit --omit=dev` 当前报告 2 个生产依赖中危告警，均来自 `@renmu/bili-api -> fast-xml-parser`；建议修复会把 `@renmu/bili-api` 破坏性降级到 1.0.0，本轮不自动升级依赖。
- 收藏夹扫描异常仍有一处会把完整 Axios 错误对象交给 `console.error`，服务端日志可能因此包含 Cookie 等请求上下文；本次 checkpoint 不修改该旧逻辑，下一轮必须改为脱敏摘要并补测试。

## 合并到 main 时的处理

1. 在 `dev` 环境完成本轮变更对应的测试路径。
2. 把本文件「当前 dev 变更」整理为 `CHANGELOG.md` 的正式版本条目。
3. 确认 README 只保留稳定用户需要看的内容，dev 测试细节继续留在本文件。
4. 合并 `dev` 到 `main` 后，确认 GitHub Actions 只为 `main` 发布 `latest`。
5. 如果要保留下一轮 dev 测试，把本文件重置为新的 dev 状态。
