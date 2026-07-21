# Dev 测试说明

本文只记录`dev`相对`main`的未发布变化。稳定内容发布到main时应整理进README、CHANGELOG或文档站，并重新建立本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.4.2`
- 当前dev变更：新增AList归档路径安全迁移；应用版本仍为`2.4.2`，状态schema 13和迁移包schema 3不变，SQLite升级到`user_version 5`。
- 文档站：<https://minori0721.github.io/Bili-favorites-backup/>

## 启动恢复标记

- `legacy_quality_download_jobs_v1=complete`：旧格式画质下载任务已完成一次性合并。标记存在时启动不再统计、查询或解析`quality_download`候选；清空状态与任务、恢复SQLite状态后重新检查。
- `legacy_temp_cache_v1=complete`：旧式无清单缓存已完成一次异步顶层检查。标记存在时启动不再读取`temp`目录；完整迁移包恢复`temp`后重新检查。
- 旧画质候选超过100000项、缺少BVID、候选变化或事务失败时不写完成标记。旧缓存枚举、读取或处理异常时同样保留标记缺失，供下次启动继续。
- 无活动收藏关系的旧BV目录只保留在残片/旧缓存清理预览中，不自动删除；该保留决定视为已处理，不形成每次启动重扫。
- 恢复状态但未恢复`temp`时保留本机原有缓存标记；仅恢复配置、账号、封面或日志不改变两个标记。

## 实现审计

- `path_migrations`和`path_migration_items`以SQLite保存迁移阶段与逐相对路径清单；扫描每批写入，复制固定单并发，目标确认后才执行状态和配置切换。
- 新旧路径要求绝对、不同、互不嵌套且第一段挂载名一致；全程使用WebDAV COPY、不覆盖目标，旧目录清理必须重新核验并输入`DELETE OLD ARCHIVE`。
- 迁移维护锁阻止调度器领取同步、下载、上传、远端确认和画质任务；队列、日志、登录和迁移状态接口继续可用。扫描、复制、核验、暂停和切换阶段拒绝导入/导出，`cleanup_pending`允许导出但仍禁止导入。

- `inspectDownloadRecoverySync()`及其专用汇总代码已删除，生产源码和测试均统一读取`inspectDownloadCache(...).recovery`。
- 异步检查器补齐`quality-upgrade-*`有效清单识别，分类结果继续覆盖可续传会话、有效分P、保留字节、旧缓存和待清理残片。
- 完成标记后的画质恢复有零候选查询断言，旧缓存恢复有零目录扫描断言；下载门控、上传不受阻、持久任务去重、关闭等待和迁移导入标记失效均有回归覆盖。

## 基线验证

```bash
npm ci
npm test
npm run build
npm audit --omit=dev
npm --prefix docs ci
npm --prefix docs run docs:build
```

- 路径迁移定向测试：14项通过，额外覆盖缺失目标根目录、延迟可见重试、重启后`copying`恢复、开始前维护锁、历史归档路径和SQL通配符边界。
- 全量测试：184项中183项通过、1项因本机缺少aria2跳过、0项失败；生产构建与文档构建均通过。
- TypeScript生产构建与`git diff --check`通过。
- 文档生产构建通过，文档站生产依赖审计为0。
- 根依赖`npm audit --omit=dev`当前报告15项上游依赖风险：`axios`、`body-parser`和`brace-expansion`的部分问题暂无修复，另有`fast-xml-parser`中危项；不执行破坏性`audit fix --force`。

## 后续合并规则

1. 新开发只在本文件记录相对main的行为、测试与已知边界。
2. 合并main前确认main仍是dev祖先，并使用`--ff-only`同步。
3. 正式发布时删除main中的本文件，把用户可见内容整理进README、CHANGELOG或文档站。
