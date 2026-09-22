# 开发架构与维护指南

本指南说明功能入口、状态与事务归属、失败处理及开发验收要求。

## 状态与事务边界

| 状态或操作 | 所有者 | 约束 |
| --- | --- | --- |
| 页面请求、加载代次、计时器 | 对应前端功能控制器 | 关闭取消，迟到结果丢弃，初始化和销毁幂等 |
| 弹窗栈、焦点、滚动锁 | 前端公共交互能力 | 功能通过公共入口开关弹窗 |
| 任务领取、租约、维护准入 | 调度控制 | 业务模块不能绕过准入自行启动任务 |
| 上传证明、传输完成、清理授权、任务完成 | 已验证传输提交操作 | 保持同一同步SQLite事务及内存状态回滚 |
| 数据库替换 | 导入维护流程 | 排空工作、统一重绑定后再恢复调度 |
| 本地成品删除 | 清理业务 | 当前代次、共享引用和远端证明重新核验后执行 |

## 模块入口与职责

- `src/web.ts` 保留页面导出入口，页面框架在 `src/web/server/page.ts`。主应用脚本与样式由资源清单定位，登录页保持独立。
- `src/web/client/bootstrap.ts` 是浏览器构建入口，`app.ts` 组装各功能。旧脚本已删除，客户端全部通过严格 TypeScript 检查；页面控制与展示辅助能力分别位于 `shared/shell.ts`、`shared/presentation.ts`。
- `features/archive/library.ts` 拥有归档导航、搜索、选择、详情及释放操作；`features/playback/controller.ts` 拥有播放器实例、队列、搜索、交付回退和资源释放。播放器事件与异步结果均核验当前实例或请求代次。
- `features/task-center/controller.ts` 组装日志、看板、待处理和媒体规格；`recovery-center.ts` 与 `media-retry.ts` 分别拥有动作确认、请求取消和轮询，不通过浏览器全局函数连接业务。
- `app.css` 只声明有序样式导入。功能样式放在对应目录，共用弹窗、内容工作区和跨功能响应式规则放在 `shared/styles`；拆分后的完整压缩 CSS 与拆分前逐字一致。
- `features/updates` 管理版本更新请求、冷却时间和按钮事件。
- `features/accounts` 管理账号列表、扫码登录、收藏选择、账号操作和账号删除弹窗；请求代次、取消控制器、提交互斥和封面观察器由各控制器所有。公开账号 DTO 在 `src/shared/api/accounts.ts` 验证，不携带凭据。
- `features/settings/controller.ts` 组装设置读取、保存、存储检查、编码顺序与模板编辑。响应在 `contract.ts` 完整校验后才写入表单；读取与保存各自取消并拒绝迟到响应。编码顺序由设置模块唯一持有，模板标签随加载和手工编辑同步。销毁时解绑事件、清除提示及焦点计时器。导入导出、重命名、画质维护分别由独立控制器持有状态。
- `features/settings/migration.ts` 持有导出、文件预览与导入请求；新文件预览成功前撤销旧导入授权，关闭或销毁取消请求，导入期间禁止替换文件。
- `features/settings/rename.ts` 持有预览会话、勾选与扫描轮询；确认时冻结当前候选，重复提交被拒绝，执行结果保留回滚与实际路径证据。
- `features/settings/quality.ts` 持有画质预览与分批提交；无法判断项不随全选自动授权，后续批次失败仍展示已提交结果，关闭后不产生下一批请求。
- `features/settings/cleanup.ts` 持有清理选项、确认文字、元数据读取与提交请求；未读取成功不能提交，关闭后迟到响应失效，部分失败结果保留成功项与失败项。所有清理测试仅使用隔离服务或浏览器拦截响应。
- `features/online-content/controller.ts` 持有在线导航、搜索、分页、列表及移动端分栏状态，网络边界在 `src/shared/api/online-content.ts` 验证。`manual-archive.ts` 持有媒体探测和归档提交生命周期；关闭后的提交响应不能修改重新打开的弹窗，探测摘要不把缺失容量误当作零容量。
- `features/path-migration` 管理状态、冲突分页、请求代次、轮询与操作互斥；`contract.ts` 收窄网络响应。
- `features/task-center/log-feed.ts` 持有日志连接、重连计时器和有界缓冲区；`logs.ts` 只负责日志模式与 DOM。
- `features/task-center/board-controller.ts` 持有看板请求、轮询、时钟、代次与最后成功更新时间，调用共享 snapshot 资源；`board-view.ts` 持有卡片缓存、列节点和可取消动画；`queue-recovery.ts` 持有恢复确认、任务互斥及请求取消。应用仅连接根节点、渲染和明确回调；销毁顺序为恢复请求、看板请求与视图，再释放共享快照。
- `features/task-center/sync-actions.ts` 持有三个同步操作的请求、确认等待和提示复位计时器；重复点击不会重复提交，页面停止后旧确认和响应不能触发新操作。
- `features/task-center/snapshot.ts` 持有一个进行中的看板快照请求。看板和待处理各自取消订阅，最后一个订阅取消才终止底层请求。迟到响应不能覆盖新请求。
- 待处理操作的结果也交给同一个快照所有者，提交操作结果时取消旧看板请求，防止操作前的列表迟到后把已处理问题重新显示出来。
- `features/archive/status.ts` 提供归档与源站状态的纯显示规则。
- `src/shared/api/archive-library.ts` 统一收窄归档导航、归档分页和详情响应；来源关系要求账号与目录编号齐全，详情复用项目解析。解析失败不会写入当前归档状态；本地释放的可选证明标志缺失时不会推断为存在证明。
- `src/shared/api/playback-queue.ts` 独立收窄播放器队列、分P、游标和搜索响应，避免播放器把未校验的流地址、文件标识或来源关系写进播放状态。
- `src/shared/api/queue-item.ts` 收窄看板列中的阶段、动作、计时和恢复动作；`queue-snapshot.ts` 在发布看板前按列补齐阶段并拒绝错误类型，问题列表仍保留其独立 DTO。
- `shared/modals.ts` 持有弹窗栈、背景可访问状态、滚动锁、动画与焦点计时器；应用入口通过明确回调连接业务关闭操作。
- `shared/notifications.ts` 持有通知节点及显示/消失计时器，关闭通知或销毁能力时一起释放。
- `shared/confirmation.ts` 管理唯一待决确认和确认文字校验；关闭或页面释放会将待决确认解析为取消。
- `shared/lifecycle.ts` 按依赖顺序初始化，按相反顺序释放；部分初始化失败也会回收已创建资源。页面返回不重复绑定事件，旧脚本及过渡适配器已移除。
- `src/shared` 只放可在浏览器和服务端使用的规则、传输边界与数据验证，不能导入 Node、Express、数据库或凭据。
- `src/scheduler/retry-policy.ts` 保留原时间规则；旧调度器导出继续兼容。
- `src/scheduler/access-rules.ts` 和 `recovery-context.ts` 提供探测目的、源状态与持久恢复上下文的直接可测规则，恢复上下文不通过 `as any` 读取。
- `src/scheduler/remote-verification-io.ts` 独立持有远端目录观察缓存及全局、路径限速预约，通过注入的时钟和 I/O 测试。清空或重绑定后，旧查询不能重新填充缓存；关闭排空后释放缓存与预约，存储连接配置变化使目录缓存失效。
- `src/scheduler/verified-transfer.ts` 是核验提交事务入口，依赖每次调用传入的窄存储接口，不缓存数据库连接。
- `src/scheduler/quiescence.ts` 提供可注入时钟的停止等待。超时保留数据库及租约；应用使用 `shutdown(..., {closeDatabase:false})`，等其他后台工作退出后统一关库。
- `src/scheduler/polling.ts` 持有自动扫描的启动与周期计时器、下一次运行时间和回调代次。重复启动不重置计时，修改周期会替换原计时器；停止后的旧回调失效。关闭一旦开始，调度器不能通过启动或配置更新重新开放任务准入，超时后仍可再次等待排空。
- `src/scheduler/runtime-timers.ts` 持有投影、任务唤醒、租约心跳及延迟同步的计时器注册；替换和取消使旧回调失效。停止生产工作时保留租约心跳，排空后统一释放。测试通过 `ScheduleTimer` 推进业务时间；等待真实异步 I/O 排空的时钟必须独立推进，不能把未推进的假时钟当作关闭超时。
- `src/scheduler/access-admission.ts` 合并充电与可用性探测意图，保留运行中任务租约；`access-probes.ts` 执行探测与提交，`startup-probes.ts` 重建持久计划。各模块测试直接注入窄仓储与外部探测，不通过调度器私有成员接线。
- `src/scheduler/retry-pending-recovery.ts` 为多个账号和收藏夹共享同一重试预算；上传执行器接受上传适配器，冲突候选测试通过真实执行入口观察结果。
- `src/scheduler/manual-archive.ts`、`access-probe-wakeup.ts`、`retry-pending-recovery.ts`、`quality-projection.ts` 与 `cycle-logger.ts` 均在运行时构造阶段组装一次。`SchedulerRuntime` 的公开方法只委派给这些稳定句柄，不能在请求或扫描周期里临时重建业务对象，也不能通过给旧方法改名绕过职责检查。
- `src/scheduler/queue-events.ts` 拥有队列事件订阅，排空后统一解绑，保留外部监听器；`task-event-bindings.ts` 只负责把生命周期事件接到明确处理器，业务失败和完成策略不再写在订阅注册处。
- `src/scheduler/persistent-job-dispatcher.ts` 是持久任务领取与队列填充的唯一入口；它只接收队列、仓储和窄回调，不持有调度器或数据库连接。`SyncScheduler` 只保留兼容委派。
- `src/scheduler/maintenance-admission.ts` 用带身份的租约管理清理、路径迁移和归档删除屏障；重复释放幂等，旧租约不能解除新操作。`safe-retry-directory.ts` 集中处理重试目录的路径和符号链接安全检查。
- `src/scheduler/queue-projection.ts` 仅接收只读存储能力和数据映射函数。看板及待处理查询不补建任务、不触发缓存扫描；显式运行阶段每 10 秒刷新缓存和恢复投影，传输会话补建继续遵守既有 30 秒节流。维护或停止期间不刷新，任务准入仍主动检查缓存。
- `src/startup-lifecycle.ts` 顺序执行启动恢复。停止后不执行后续步骤，当前步骤未排空时不能关闭数据库。过期归档恢复记录的对账必须完成后才重建后续持久任务；对账失败向启动生命周期传播，不能先开放调度。调度器构造阶段不启动后台工作或规范化任务记录。不可用封面补全是可降级后台任务，只在关键启动链成功后启动，异步失败通过结构化错误边界报告。
- 数据库重绑定仅可在空闲清理屏障内执行；先绑定全部适配器并完成导入数据的旧版本恢复，迁移事务提交后才调用 `resumeAfterStateRebind` 恢复准入。回滚同样重新绑定原数据库后再恢复。任一适配器或恢复步骤失败期间保持禁止调度并进入 fail-closed 维护状态。旧缓存检查通过运行代次失效。
- `src/scheduler/quality-maintenance.ts` 负责候选判断、预览与提交前复核；仅注入当前配置、归档投影、账号读取和任务准入函数，不持有调度器或数据库连接。对应路由在 `src/http/quality-maintenance.ts`，批量请求先完整校验，再开始提交。
- `src/scheduler/quality-rules.ts` 负责画质任务目标归一化、来源选择、证明文件合并和序列化；`src/scheduler/recovery-projection.ts` 负责持久恢复评估、旧归档证明和恢复文件投影，均不持有调度器或数据库连接。
- `src/scheduler/quality-task-factory.ts` 负责画质任务重建、回调绑定和完成提交；调度器只注入配置、存储、队列唤醒与恢复复核能力，不把整个调度器传入任务。
- `src/scheduler/recovery-commit.ts` 负责恢复确认的同步提交边界；旧归档证明、传输会话收尾和任务完成在同一 `runAtomic` 范围内，提交失败时保留原会话与原归档状态。
- `src/scheduler/recovery-identifiers.ts` 只负责旧版和新版下载恢复目标、失败键的纯解析；恢复动作通过调度器现有状态接口执行。
- `src/scheduler/local-cleanup-plan.ts` 只根据本地清单、文件身份和已核验远端文件生成清理授权；删除执行仍由 `local-cleanup.ts` 持有。
- `src/http/path-migration.ts`、`src/http/sync-control.ts` 与 `src/http/online-content.ts` 由应用注入对应服务和统一维护包装器，认证及同源保护保持在装配入口。

## 开发与验证

```sh
npm ci
npm run dev
npm run typecheck:web
npm run check:architecture
npm test
npm run test:ui
npm run build
npm audit
```

`npm run dev` 先构建浏览器资源，再启动服务端。浏览器源码变更后刷新页面生效；服务端源码变更先请求旧进程正常退出，再启动新进程。退出异常时停止自动重启并报告错误。禁止用真实数据测试故障恢复。

构建先执行架构约束，再分别检查服务端、浏览器和测试 TypeScript，构建浏览器资源，编译服务端，最后验证清单和资源摘要。输出都在 `dist`；现有 Docker 构建复制完整 `dist`。测试假服务共用真实应用的资源响应实现。

运行镜像使用 Tini 作为 PID 1，转发停止信号并回收下载器留下的孤儿进程，Node 继续负责业务停止顺序。构建阶段已改为复用已通过构建的 `node_modules` 并执行 `npm prune --omit=dev`，避免在无 Python 的精简运行镜像中重新编译 `better-sqlite3`。媒体测试需要准备运行镜像中的媒体工具。

`npm test` 递归发现 `tests` 内所有 `.test.ts`，浏览器行为测试由 Playwright 独立运行。新增模块测试应测试公开接口和可观察行为，不通过 `window` 或源文件文本访问实现。

日常开发可以使用测试入口的快速范围，减少等待时间，但这些范围不能代替推送前的全量测试：

```sh
npm run test:quick
npm run test:decoder
npm run test:upload
npm run test:scheduler
npm run test:files -- tests/domain-decoders.test.ts tests/playback.test.ts
```

不带范围的 `npm test` 始终递归执行所有测试文件，是 dev 推送和发布前的完整门槛。指定范围只改变本次本地执行的文件，不会改变 CI 的测试范围；修改调度、存储、事务或跨模块边界后仍须执行完整测试。

### dev → main 验收复用

先推 dev 并等待 `Docker Publish` 成功，再将该提交快进合并到 main。main 的 push 流水线通过 GitHub Actions API 查询同一仓库、同一工作流、同一完整提交 SHA 的成功 dev push，同时要求工作流 SHA 一致，且对应 run attempt 的 `Test application` 步骤实际执行成功，才跳过重复的 `npm test` 和测试媒体工具准备。提交 SHA 包括版本、依赖锁文件、测试与工作流配置；任何新提交都必须有对应的成功记录，不能只凭业务文件看起来没变而跳过。

没有记录、工作流版本不明、测试步骤跳过、dev 尚未完成、失败或 API 不可用时，main 自动执行全套测试。dev、正式 tag 和手动触发始终执行测试；需要强制复验 main 时使用 `workflow_dispatch`。工作流修改本身也会触发 CI。判定脚本为 `scripts/dev-test-evidence.mjs`，对应边界测试为 `tests/dev-test-evidence.test.ts`。

安装依赖、构建（含类型与架构检查）、发布说明校验、镜像构建与发布后的隔离启动检查始终执行；文档站仍独立构建部署。跳过测试的运行摘要记录复用的提交 SHA、工作流 SHA 和 dev run 链接及 ID，便于追溯。UI 仍按改动范围在本地验收，不能把此复用规则当成 UI 已自动运行。

架构检查禁止客户端导入服务端代码、跨功能导入内部文件、新模块运行时循环依赖、业务模块依赖整个调度器、组合根内联 HTTP 处理器、生产或测试代码使用显式 `any`，以及静默恢复。调度运行时的职责检查解析实际导入符号及其声明文件，覆盖重命名、命名空间和索引调用；业务工厂只允许在构造阶段组装，其他成员只能调用已组装端口。注释不能豁免空 `catch` 或关键异常吞噬；合法降级必须返回明确失败结果、传播异常，或通过登记的局部边界产生可观察结果。Artplayer 仅导入已安装版本的类型，运行时仍使用既有受保护厂商资源路径。

`scheduler-ownership.json` 覆盖当前调度器的每个实例字段，只记录一个实际所有者和生命周期要求。`resource-ownership.json` 以“模块、所有者符号、资源符号”登记所有调度工作流和浏览器控制器持有的 Promise、计时器、锁、缓存、请求与运行代次，并写明停止、迟到回调和重绑定行为。架构检查自动扫描 `scheduler/`、`web/client/features/` 与 `web/client/shared/` 的导出工厂和类，递归检查闭包状态并跳过每次调用才产生的局部函数体；新增所有者未登记、符号遗漏、失效或重复都会失败。完成迁移后更新 `currentOwner`，不再保留未落实的 `targetOwner`。

收藏夹详情由 `features/archive/video-detail.ts` 持有分页、筛选与当前播放上下文，仅向播放器返回上下文快照；下架清单由 `unavailable.ts` 分别持有两个筛选的游标与缓存。`video-card.ts` 统一拥有复核请求和按钮状态，按展示区域释放，避免关闭后迟到通知。传输数据由 `shared/api/video-detail.ts` 校验后才进入视图。

## 最终收口与发布边界

- 恢复动作按下载、上传续传、编码、画质、冲突选择和放弃处理分别提供入口，共用 `recovery-work` 的任务锁；远端检查后再次核验代次及任务证据。
- `startup-recovery`、`startup-probes` 与 `legacy-quality-migration` 处理启动重建，`legacy-cache-recovery` 拥有异步缓存扫描。`transfer-recovery-projection` 拥有投影节流，数据库重绑定清空该节流。
- `account-retirement` 拥有账号退役请求和取消标识，重复请求共享 Promise，忙碌状态参与维护及关闭排空；`retirement-transfers` 处理遗留本地成品，`source-deletion` 处理来源删除协调。来源删除通过 `StateManager.runAtomic` 提交关系、任务与清理授权，不把裸 SQLite 连接传入工作流。HTTP 入口位于 `http/account-removal`、`http/archive-deletion` 和 `http/recovery`，注册位置及统一认证、维护包装器不变。
- 发布按 dev → main → tag 执行；具体提交的验收结果记录在提交说明、PR 或 CI 中。

`favorite-scan.ts` 已拥有收藏扫描策略、自稿件缓存、认证重试与分页处理；时钟、随机数、远端适配器和任务提交均明确注入。扫描页、认证和封面回调检查运行代次；原调度器继续持有活动同步工作的准入与排空。

`local-cleanup.ts` 已拥有清理扫描、重试和运行中操作，删除前核验代次、维护准入、共享引用与持久授权；`local-cleanup-plan.ts` 负责生成清理授权，`local-cleanup-storage.ts` 通过 `StateManager` 的窄读接口每次同步读取当前数据库，不缓存裸连接。损坏的任务 JSON 会带上下文抛出并阻止错误清理。本地释放路由位于 `http/local-release.ts`，沿用统一维护边界。容量缓存由 `local-capacity.ts` 持有。

`src/scheduler.ts` 现在是稳定的兼容门面，只保存 `SchedulerRuntime` 引用并委派公开入口；调度依赖装配、队列接线和生命周期实现位于 `src/scheduler/scheduler-runtime.ts`。同步运行状态由 `sync-runtime.ts` 持有，探测、下载准入、传输健康和画质锁分别由对应工作流持有；运行时只通过生命周期和窄回调协调它们。工作状态查询由 `work-state-projection.ts` 统一读取，运行时不再重复实现“是否忙碌、是否有持久工作、是否可进入清理”的业务判断。维护租约、路径迁移和归档删除摘要由 `maintenance-coordinator.ts` 统一拥有；清理回调即使同步抛错也会释放原租约，旧 token 不能释放后续维护。后续业务改动从对应工作流或端口进入，不把新策略重新写进门面、队列订阅或装配闭包。按职责维护，不以机械行数拆分或长期保留第二套业务实现。

配置变更由 `runtime-config.ts` 负责：它只接收队列、准入、容量和唤醒端口，更新编码/画质任务配置与队列容量；运行时保留公开委派入口，不再直接承载配置分支。

看板和调度状态由 `scheduler-status-projection.ts` 从同步状态、仓储查询和健康快照组装；投影不启动任务或修改业务状态。启动恢复的固定顺序由 `startup-resume-workflow.ts` 负责，过期租约、传输会话、旧任务迁移、访问探测和持久任务恢复全部完成后才触发调度。

已核验上传的前置校验、清理授权生成和原子提交由 `verified-transfer-commit.ts` 提供唯一命令入口；调度运行时只转发队列完成事件，不能拆开写入归档证明、传输会话、任务完成和清理计划。

画质任务重建及阶段完成转换、恢复标识解析均由独立模块负责。

`verification-jobs.ts` 生成单文件和传输会话的核验任务；`verification-handlers.ts` 持有核验完成、缺失等待、冲突停放和错误策略。恢复移交字段由 `verification-payload.ts` 验证。父子任务与归档证明的同步事务保持整体。

`recovery-assessment.ts` 持有人工恢复的远端证据评估；`recovery-local-files.ts` 验证本地路径、代次和文件身份。实际恢复动作通过明确回调进入原有准入与提交入口，不持有裸数据库连接。

`recovery-work.ts` 是恢复请求与人工操作锁的共同所有者。同一任务的并发评估共享 Promise，失败后释放运行槽位；关闭及维护同时等待评估请求和人工操作锁排空，不会在只剩人工动作时误判空闲。

`download-completion.ts`、`upload-completion.ts`、`download-failure.ts`、`upload-failure.ts` 和 `task-progress.ts` 分别持有下载/上传完成、失败及进度事件的业务策略。同步事务整体迁移，原始错误交给分类器，直接读取的控制标志及媒体诊断由 `task-failure.ts` 收窄。

`recovery-automation.ts` 拥有启动/周期计时器及运行中批次。重复运行共享 Promise，停止或运行代次变化后不继续下一项，关闭与维护继续等待 busy 结束。后台错误明确记录，显式运行仍向调用者返回失败。

`recovery-issue-projection.ts` 是待处理列表及计数的唯一组装实现，输入由 `recovery-issue-payload.ts` 收窄；看板复用恢复摘要规则。架构检查拒绝包含 any 的类型断言，覆盖泛型中的间接逃逸。

恢复下载必须使用 `backup-enqueue.prepareRecoveryDownload`，不因旧下载清单仍标记完成而复用本地上传。准备结果区分 download、upload、probe，commit 的布尔值只表示提交是否成功；普通 enqueue 仍保持“探测不计作已排队备份”的外部语义。旧失败记录仅在替代工作提交成功后清除，上传恢复仅接受明确的 download 结果，不能把权限探测当作下载完成移交。

浏览器受保护的 HTTP 请求统一经过 `shared/session`，再分别进入 JSON API、版本检查或导出响应处理。401 在正文解析前使当前页面会话失效，并通过应用入口卸载功能、停止轮询与日志连接，展示重新登录入口；登录后重新加载页面，不重放旧请求。普通断网与 403/409/503 不触发会话失效。日志连接失败通过同一通道确认认证状态，停止后取消确认和重连。浏览器取消请求不代表服务器已取消业务操作。

## 当前组合根边界

`src/index.ts` 是组合根，只负责基础设施、服务工厂、路由顺序和启动/关闭装配；账号、配置、收藏、登录、播放、迁移、清理、媒体探测、更新检查、可用性复核和队列状态均通过服务与窄 HTTP 路由接入。组合根把兼容门面收窄成 `SchedulerControl`、`SyncControlPort` 与 `RecoveryPort` 后再交给生命周期和 HTTP 路由，路由看不到完整调度器。`SyncScheduler` 仍保留兼容门面，运行时准入、恢复、扫描和传输策略由现有工作流工厂委派；新增业务不得再直接写入门面。远端重命名由 `rename-service.ts` 持有扫描缓存与预览会话，播放请求的参数由 HTTP 边界校验，`playback-service.ts` 在每次操作时取得当前数据库。

调度运行时的准入、关闭和数据库重绑定由 `scheduling-runtime.ts` 持有；同步状态和扫描流程分别由 `sync-runtime.ts`、`sync-workflow.ts` 协调，恢复流程由 `recovery-workflow.ts` 协调。仓储接口位于 `repositories/`，只暴露领域读写，连接替换仍由 `StateDatabase` 统一完成。持久 JSON 在 `repositories/domain-decoders.ts` 的边界解码，清理授权由 `repositories/cleanup-plans.ts` 读写。

## 新增或修改功能的入口

- API 边界测试应将真实服务查询结果经过 `JSON.stringify` / `JSON.parse` 后交给浏览器解析器，覆盖序列化后的类型、可选字段和历史哨兵值。UI 假服务须与该契约一致，不能单靠手写假数据证明前后端兼容。归档导航的 UID 是数字，历史移除账号可为 0；对应回归在 `tests/archive-library.test.ts` 和 `tests/web/archive-library-contract.test.ts`。
- 前端功能从 `features/<feature>/controller.ts` 或该目录的既有公开入口开始；由 `app.ts` 注入 DOM 根节点、API 与明确回调。共享网络数据先在 `src/shared/api` 收窄，功能内部文件不跨目录引用。请求、计时器和事件监听与拥有它们的控制器一起销毁。
- 任务创建使用 `download-task-factory`、`upload-task-factory` 或 `quality-task-factory`。异步回调携带创建时的运行代次；调度控制仍统一决定任务是否能领取和启动。
- `backup-enqueue.prepare` 在事务外读取本地文件与历史清单，返回只做同步存储变更的 `commit`。普通入队由模块提交后唤醒；恢复替换由 `recovery-finalization` 或 `legacy-download-recovery` 把来源重置、新任务入队、旧会话和父任务收尾合并到一个 `runAtomic`，成功后才唤醒。禁止在事务里等待网络或文件操作。
- 冲突选择通过 `conflict-resolution` 提交候选决议、归档证明和任务完成；放弃通过 `recovery-abandonment` 提交。共享同一任务锁，提交任一部分失败整体回滚。不要在路由里重复拼装这些事务。
- 调整数据库导入、删除或停止流程时，执行真实隔离 SQLite、故障注入和应用冒烟回归；检查维护屏障内所有适配器重新绑定成功后才恢复准入。停止超时保留租约和恢复证据，不把超时报告为空闲。
- 修改前端执行严格类型检查和 UI 三视口回归；修改调度/存储执行完整 `npm test`；合并前执行本地构建、架构检查、UI 和依赖审计；镜像构建与隔离启动由对应提交的 GitHub Actions 验收。嵌套测试由入口递归发现，无需手工补文件清单。

## 输入契约

- 浏览器 API 数据以 `unknown` 进入解析器。归档、播放、队列和媒体探测的非法响应抛出 `ResponseFormatError`，`code` 为 `INVALID_RESPONSE`；控制器保留上次有效数据并展示错误，不发布伪造的空列表。
- `parseBBDownProbeOutput` 返回 `empty / invalid / partial / ok`。非法记录附带原因与结构化记录序号；部分结果携带此前有效记录，仅供诊断，不能用来完成探测或授权清理。互动视频仍必须通过完整页集合证明检查。
- `empty` 是没有结构化输出；`ok` 是通过验证的完整输出。JSON 损坏、字段非法、重复页码和重复 CID 不能变为 `[]`。
- SQLite 查询结果在仓储边界按查询分别进入任务、计数、调度时间、重试、会话身份、BVID 与画质目标解码器；完整任务再由 `rowToJob` 校验。业务代码不接收通用行对象，也不通过 `Number(value || 0)` 或字符串强转制造合法值。数据库替换日志、导入事务日志和下载会话清单分别使用领域解码器，结构不完整时拒绝恢复或把证据判为无效。配置、账号与日志文件同样从 `unknown` 逐字段解码。
- 下载会话读取明确返回 `missing / invalid / valid`。只有文件不存在是 `missing`；JSON、版本或字段损坏是 `invalid`；其他文件系统错误向上传播。损坏清单不能授权上传、替换或自动清理，重新探测前必须成功保存原件。缓存统计把损坏目录计入保留空间，不把它算作旧缓存或可清理残片。
- B站在线内容按收藏、合集、追番追剧、稍后再看和历史接口的实际字段解码。合法空数组是空页；缺少列表、坏条目或非法分页字段是响应错误。全量收藏扫描只有完整读完所有页面后才能标记完成和失效未出现项目。
- 完整看板需要调度、恢复和四个队列字段。待处理操作响应只提供问题列表，由 `parseQueueIssueUpdate` 解析，不能补造调度状态或覆盖看板列。
- 媒体探测的 `running / failed / complete` 分别处理：失败保留原因并允许用户既有的手动画质选择流程；只有完成态要求完整结果。播放的 `partial` 字段继续描述已知的部分归档。
- 同一归档页中的重复视频、同一播放项目中的重复文件是契约错误。分页控制器继续处理不同页重叠与迟到响应，不因一次非法页清空已有内容。

## 生产错误处理

| 场景 | 处理 |
| --- | --- |
| 封面、历史日志读取、进度采样、临时文件清理失败 | 使用带组件和操作上下文的脱敏日志；损坏日志保留副本并降级为空的内存历史，不宣称原记录有效 |
| 外部探测暂时失败 | 保留错误与现有重试状态，不推断视频不存在 |
| 持久 JSON 损坏、恢复任务提交、迁移失败 | 向上抛出；不得变成空状态、零修复项或成功 |
| 数据库替换后的旧连接关闭失败 | 保留恢复文件，报告 `recoveryRequired`，不继续移动数据库 |
| 清理已失败操作的临时资源 | 可记录清理错误后继续抛出原始错误，防止掩盖原始故障 |
| 下载关闭超时 | 不报告空闲；不主动关闭仍可能被回调访问的数据库 |

SQL NULL 表示可选字段缺失，损坏的 JSON 不是缺失。数据库查询和迁移不能把解析失败替换成默认对象。

充电权限恢复时，解除限制、完成探测、更新画质任务及创建后继下载在同一 `runAtomic` 中提交。外部探测发生在事务外，提交前仍检查代次、维护状态与租约。

## 生命周期与测试

- 应用装配传入 `deferAdmissionUntilStart`，恢复流程完成前不开放调度。独立调度器调用保持既有 API 默认行为。
- `createStartupLifecycle` 记录每个具名步骤的 `success / degraded / failed`，关键步骤失败停止后续步骤。可降级步骤必须提供错误记录函数。
- `PersistentJobStore` 接收可注入的 `now`；调度器和存储使用同一时钟，避免旧测试日期被墙上时钟重新排期。
- 状态、计时器、锁和请求的所有者继续以 `scheduler-ownership.json` 为准；启动生命周期持有当前串行 Promise，停止只阻止后续步骤，排空必须等待当前步骤结束。
- 新测试调用功能模块工厂或公开服务，不通过调度器私有字段准备场景。`charging-access.test.ts` 使用 `createAccessProbes`、`createBackupEnqueue` 和真实隔离 SQLite；故障通过 SQLite 触发器注入。
- 测试覆盖权限恢复事务回滚、旧代次/维护/租约中断、启动失败阻止调度、坏 JSON、重复记录、部分结果和 CI 证据缺失。现有导入回滚、恢复证据、取消、超时和唯一副本测试继续保留。
- `npm run typecheck:tests` 对 `tests/typecheck/` 中的公开端口、外部适配器替身和持久载荷解码执行严格 TypeScript 检查；完整行为测试仍由 `npm test` 通过 `tsx` 顺序执行，架构检查覆盖所有可执行测试的显式 `any` 与私有成员访问。
- `npm run test:files -- <files...>` 将 `--files` 后的路径视为测试文件并按规范化绝对路径去重；Node 测试参数必须写在 `--files` 前，指定文件不会再次作为运行器参数重复执行。

## 架构门槛

同步工作流的能力按命令、生命周期、查询和扫描回报分成窄接口；查询返回只读快照，扫描统计通过回报方法写回唯一状态所有者。调度运行时只组装并委派账号准入、手动同步命令、恢复投影和画质任务恢复，账号准入由 `user-sync-eligibility` 持有，画质恢复失败由 `quality-recovery-admission` 统一暂停并记录。

任务仓储的聚合计数、会话身份、BVID 与画质目标投影在 SQL 边界使用具体解码器；非法数量、代次或身份直接报错，只有普通查询缺行才表示不存在。旧传输任务仅在 SQL 明确标记“历史缺少代次”时映射为第一代，当前记录缺少或伪造代次会失败。下载会话必须包含完整元数据、输出和历史数组，损坏输出、重复身份、无效选择时间或路径会使证据失效；配置、账号和 B 站权限字段均从 `unknown` 逐字段收窄。

`npm run check:architecture` 使用现有 TypeScript AST 检查空 catch、显式 any、静默恢复、解析器空集合兜底、测试访问调度器私有成员、别名和索引访问绕过，以及模块循环依赖。同步消费者不能借 `ReturnType<typeof createSyncRuntime>`、交叉类型、重命名导入、命名空间或重新导出拿回完整实现能力；工作流不能调用 `getDatabase()`，只能接收所需查询或提交能力。`tests/failure-boundaries.test.ts` 为各规则提供通过、失败和绕过示例。

测试访问调度器私有成员不接受历史基线豁免。业务工厂测试直接注入仓储和外部适配器；集成测试通过队列事件、公开生命周期与持久结果验证协作，不把另一个仓储实例上的方法替换误当作调度器故障注入。

历史 failure-boundary 放行文件已删除；检查器不再按历史额度放行已知违规。所有规则都必须通过具体的局部边界或公开契约修复，不能靠增加基线条目绕过。SQL 行类型继续按仓储和查询定义收窄，禁止用 `undefined as unknown as T` 制造记录。

## 远端文件身份与统计

`remote_files` 同时保存视频级记录（空账号、收藏夹编号 0）和收藏关系级记录，行数不是独立远端文件数。视频数按 BV 去重，登记文件数按存储目标和远端路径去重，来源引用数仅统计收藏关系级记录；数据库登记数量不等于实时远端盘点结果。当前数据库使用一个配置的远端存储目标。

归档导航通过 `remote-reference-query.ts` 的只读查询统一统计：`total` 保持按 BV 去重的视频数；`sourceReferenceCount` 是当前目录的来源文件引用行数；`uniqueRemotePathCount` 按这些引用的路径去重。只计入可见账号中仍有关联、未完成删除的来源，排除视频级副本和孤立行；待核验、缺失等状态仍是登记引用，不代表远端文件实际存在。全局路径数必须独立去重，不能相加各账号计数。手动归档（mediaId=-1）也属于真实来源。

前端目录导航显示这三种口径，搜索结果标题继续只显示当前筛选的视频统计；不要把目录引用数混入搜索结果。新增字段缺失时兼容旧响应并省略展示，部分缺失或非法值必须报格式错误。不要在浏览器按数组长度重算引用或将路径数称作实存文件数。删除预览与恢复仍使用原有服务及证明边界，本查询不授权任何写入或删除。

普通核验、重试和说明更新原地更新文件行，保留 ID；显式新上传时间或已知文件大小改变时生成新的文件 ID，删除后重新登记也不复用 ID。播放地址、进度指纹和浏览器媒体信息回报共同使用该文件身份，不使用普通 `updated_at` 判断内容变化。历史文件缺少上传时间时保持身份；首次切换到稳定指纹格式时，旧格式保存的播放进度不自动认领。仅凭路径与大小无法识别绕过应用的同路径、同大小外部改写，此机制不宣称具有内容哈希校验能力。

文件列表更新、来源状态和查询投影仍处于同一 SQLite 事务；移除文件只影响目标来源。待核验查询先关联有效的待确认收藏关系，再聚合、排序和分页，视频级记录不占分页名额。启动恢复同步遍历所有分页，仅写入任务，不改动被遍历的来源集合；后台执行继续遵守原有 `notBefore`，不得用分页取消重试延迟。

## 本地与 CI 的验收分工

UI 使用独立假服务，覆盖桌面、手机和横屏。dev 日常开发不重复进行本地 WSL/Docker 镜像验收，镜像构建与隔离启动由 GitHub Actions 执行。只有对应提交的工作流成功，才算通过镜像验收；本地测试与历史镜像结果不能代替当前提交的 CI 证据。文档站依赖单独审计和安排升级，避免在业务重构中顺带升级整套工具链。

测试数量、日期、临时环境故障和推送状态写入提交说明、PR 或 CI 记录，不作为长期开发指南内容。临时日志、截图和调试草稿仅保存在本地忽略目录。
