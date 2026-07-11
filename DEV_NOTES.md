# Dev 测试说明

本文只记录 `dev` 分支相对 `main` 的当前测试内容。确认稳定并合并到 `main` 时，把需要公开给用户的内容整理进 `CHANGELOG.md`，然后重置本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.3.3`
- 当前 dev 变更：上传可靠性、失败隔离补传、BBDown fork Release、aria2字节续传、分P会话恢复、网页/APP接口模式和播放风控自动恢复，尚未合并到 `main`。
- 镜像预期：推送 `dev` 分支后发布 `minori0721/bili-favorites-backup:dev`；`latest` 仍只由 `main` 分支发布。

## 当前 dev 变更

- AList WebDAV 流上传显式发送准确 `Content-Length`、MIME、`X-OC-Mtime` 和 `X-OC-Ctime`，拒绝空文件/空目录；PUT 后最多 3 次核验远端文件大小。
- 含 Emoji 等四字节字符的文件名仍优先按原名上传；仅原名出现确定性 400/405/422 时，才使用去除四字节字符的兼容名重试一次，并记录、校验实际远端文件名。正常支持 Emoji 的 AList 驱动不会被改名，兼容名与现有文件冲突时会自动追加稳定序号。
- 远端目录创建只忽略“并发创建后复查确实存在”，认证、权限、405、限流和驱动错误会继续向上传任务传播。
- 状态 schema 升级到 11；保留 schema 9 的 `upload_failed` 和 schema 10 下载会话，新增下载接口冷却截止时间、探测 BV、账号和实际探测模式，重启不会绕过冷却。
- `StateManager` 增加显式批处理和测试注入写入器；启动状态规范化只进行一次合并保存，普通任务仍立即落盘。
- 新增 `startupRecoveryBatchSize`（默认 25，范围 5–100）；启动恢复使用高低水位和轻量 backlog，本地待补传/已下载优先于无本地文件的恢复下载。
- “每轮最多补传数量”改为跨账号、跨收藏夹共享的全局预算；下载队列和上传队列均使用硬容量上限，画质重调上传溢出时进入有界 backlog。
- 上传错误统一分类、脱敏和限长；401/403 立即熔断，重复确定性错误和连续瞬时错误按阈值熔断，指数退避并支持 `Retry-After`，半开只放行一个本地上传探测。
- 单个文件的确定性错误不会继续占用优先补传锁：本地文件保持 `upload_failed`，转入约 6 小时后的低优先级隔离补传，其他下载和上传立即继续；多个任务出现相同错误时仍会触发全局熔断。
- 下载启动同时检查上传健康、优先补传、上传队列容量和缓存安全空间；缓存预留 `max(512 MiB, 上限的 10%)`，上传恢复后自动继续。
- `/api/queue/state` 增加 `uploadHealth`、`downloadApiHealth`、`recovery` 和 `localCache.reserveBytes`；页面仅在对应异常时显示上传或 B 站风控横条，保留原四列队列布局。
- BBDown 使用 fork Release `bfb-1.6.3-259a5558.1`，源码提交 `42815977dff36d2bab783ce125e209191dcca037`，Linux x64 zip SHA256 为 `b647d7e76721cab9162cb8945cde8f481e3d2996727c599ece2720855fd004a7`；Docker 不再安装 .NET SDK 或现场编译。
- fork 会把 Web 播放响应中的 `v_voucher` 转成 `BFB_SIGNAL:RISK_V_VOUCHER`，成功取得播放流后输出 `BFB_SIGNAL:PLAYURL_READY:WEB|APP`；风控响应不写 Debug JSON，也不进入 BBDown 内部重复解析。
- 全局设置新增“网页接口 / APP接口”：APP 模式所有新任务使用 `-app`，保存时要求所有启用账号具有 `accessToken`；Hi-Res / Dolby 自动切换 APP，后端拒绝 Web 与高级音频的矛盾配置。
- Web 模式触发 voucher 后全局冷却固定 180 秒，原失败任务带 `notBefore` 高优先恢复；冷却后只允许一个任务探测，有 token 时临时用 APP，无 token 时继续 Web。收到 `PLAYURL_READY` 立即恢复，不等待整个视频下载完成。
- BBDown 新进程启动间隔固定随机 3–6 秒；已经取得地址并运行的 aria2 不会因新风控信号被终止。等待任务会采用新保存的接口模式，运行中任务不中途切换。
- 下载统一启用 aria2；`.bfb-download.json` 记录账号UID、配置指纹、分P CID、成品验证和历史分P，不保存 Cookie、Token 或签名URL。
- 下载不再开跑前删除 `temp/<BVID>`；只下载缺失分P，ffprobe 验证失败的混流成品移入 `_invalid`，普通断网保留 aria2数据；只有 416、长度变化或控制文件损坏才隔离当前音视频轨道。
- 当前分P以 CID 对账；分P重排会安全改名并复用相同 CID，新分P继续下载，被替换/删除的旧成品上传到 `_history/<快照时间>`，完全不可访问时可形成“部分备份”。
- 上传器使用显式文件白名单，不会上传会话清单、Debug JSON、aria2控制文件和 BBDown 原始轨道。
- 启动会自动接管没有清单的旧 BV 缓存；有效成品复用，旧封面导入 WebP 缓存，不可信残片只进入二次确认清理项；损坏清单会先保留副本再重建。
- 所有目标和历史文件上传完成后只删除已验证白名单成品；其他无法确认的内容写入待清理标记，不再随整个目录自动删除。
- SIGINT/SIGTERM 会停止调度并按进程树终止 BBDown/aria2，最多等待20秒，以便续传控制文件落盘。

## 测试重点

- WebDAV：准确长度、非 chunked、MIME/时间头、201/204、延迟可见、大小不一致、空文件/空目录、每次重试的新文件流，以及四字节文件名原名成功/兼容名回退/冲突避让。
- 错误处理：目录并发创建、401/403/405/429/500、超时/连接重置分类、`Retry-After`、脱敏和本地文件保留。
- 状态与恢复：schema 8→11、未完成会话继续下载、完整会话直接上传、部分备份、关系级部分失败、多目标完成后清理和下载接口冷却重启恢复。
- 下载会话：旧成品自动接管、CID替换与重排、配置变化隔离不兼容残片、损坏清单保留、嵌套命名模板、分P范围压缩、ffprobe时长/流/快速哈希验证。
- 上传白名单：只上传清单成品，历史分P单独远端目录，Debug和控制文件不进入WebDAV。
- 压力场景：约 6 MiB、1000 条持久化任务；首批内存任务 25 条，低水位补齐后仍为 25 条，状态完整写入不超过 2 次，RSS 小于 300 MiB。
- 应用回归：隔离目录登录、配置更新、`/api/queue/state`、迁移导出和导入预览。
- 当前自动化结果（2026-07-11 复测）：`npm test` 共 59 项全部通过、0 跳过；使用工作区临时 aria2 1.37.0 实测断线后 Range 续传，覆盖 Web/APP 参数、带时间戳机器信号、180 秒冷却、单探测、失败重新冷却、重启恢复和 3–6 秒启动间隔。`npm run build` 与 `git diff --check` 通过。
- 内置浏览器：桌面端接口分段控件、Hi-Res 自动切 APP、风控异常横条和四列队列通过；390×844 下页面无横向溢出，接口控件宽 230px、异常条宽 313px，均保持在 390px 视口内，控制台无错误。移动端截图接口超时，但 DOM 尺寸与交互检查通过。
- 隔离异常场景：本地模拟 AList 401 后显示“上传后端异常，下载已暂停”和下次探测时间，错误凭据已脱敏，正常/异常页面控制台均无错误。
- 服务器临时验证：未替换或重启 `bili-favorites-dev`；在一次性 Bookworm 容器挂载 `.1` 二进制，SHA256、`--help`、`PLAYURL_READY:WEB` 和 `PLAYURL_READY:APP` 均通过。现场未再次触发 voucher，真实风控标记由 fork 源码和本地模拟覆盖。
- GitHub Actions 固定 `ubuntu-24.04`，升级到 Node 24 运行时 Actions，删除 QEMU 和重复 aria2 安装，增加 GHA Buildx 缓存；测试和 TypeScript 构建通过后才发布镜像。

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
- 本机不构建 Docker、不部署服务器；BBDown Native AOT 由 fork Release 工作流构建，BFB Docker 固定下载并校验该产物。GitHub Docker 工作流会完成全量测试和应用构建后再发布镜像。
- `npm audit --omit=dev` 当前报告 2 个生产依赖中危告警，均来自 `@renmu/bili-api -> fast-xml-parser`；建议修复会把 `@renmu/bili-api` 破坏性降级到 1.0.0，本轮不自动升级依赖。
- 收藏夹扫描异常仍有一处会把完整 Axios 错误对象交给 `console.error`，服务端日志可能因此包含 Cookie 等请求上下文；本次 checkpoint 不修改该旧逻辑，下一轮必须改为脱敏摘要并补测试。

## 合并到 main 时的处理

1. 在 `dev` 环境完成本轮变更对应的测试路径。
2. 把本文件「当前 dev 变更」整理为 `CHANGELOG.md` 的正式版本条目。
3. 确认 README 只保留稳定用户需要看的内容，dev 测试细节继续留在本文件。
4. 合并 `dev` 到 `main` 后，确认 GitHub Actions 只为 `main` 发布 `latest`。
5. 如果要保留下一轮 dev 测试，把本文件重置为新的 dev 状态。
