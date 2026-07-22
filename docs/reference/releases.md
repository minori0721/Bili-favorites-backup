# 版本与升级记录

文档导航中的版本号自动读取仓库根目录`package.json`，无需在站点配置中重复修改。

## v2.4.3

- 新增AList归档路径安全迁移：同一挂载内扫描整个旧目录，使用不覆盖的WebDAV COPY、延迟可见确认和SQLite持久进度。
- 迁移完成前调度器保持维护锁；切换后旧目录默认保留，清理必须重新核验并输入`DELETE OLD ARCHIVE`。
- 旧格式画质任务和无清单缓存改为一次性启动检查，完成后不再反复枚举任务或读取`temp`目录。

### 升级说明

- SQLite schema 1至4会在升级前生成一致性备份和SHA256摘要，再自动升级到`user_version 5`。
- JSON兼容状态继续使用schema 13，迁移包继续使用schema 3。
- 升级不会自动移动现有归档；只有完成迁移预览、COPY和远端确认后才会切换目标路径。
- AList `v3.61.0`下天翼驱动的COPY延迟和目录删除行为尚未经过真实部署验证，首次使用应选择测试目录并保留旧目录。

## v2.4.2

- 文档站改为Photo风格介绍首页，并统一文档站与应用页签图标。
- 队列看板保持每秒刷新，文件缓存与恢复统计改为共享的10秒异步快照。
- SQLite升级到`user_version 4`，充电限制和远端核验调度使用标量列及索引。

### 升级说明

- schema 1至3会自动升级；升级前在`data/backups`生成一致性SQLite备份及SHA256摘要。
- JSON兼容状态继续使用schema 13，迁移包继续使用schema 3，不需要重新导出迁移包。
- `v2.4.1`及更早镜像不能直接打开schema 4数据库；回滚时恢复升级前备份或使用兼容JSON导出。
- `data`和`temp`仍必须持久化，Node.js、BBDown、AList及Docker平台要求没有变化。

## v2.4.1

- 充电视频识别与七日权限复查。
- 上传冲突归档、会话重试和无效残片分类。
- schema 3迁移包、原子回滚、登录限速与统一日志脱敏。
- SQLite热路径、Debug轮转和同画质共享下载。
- 应用版本/GitHub入口、Node 24与依赖维护。

### 升级说明

- SQLite `user_version`会升级到3，旧状态字段和配置自动迁移。
- JSON兼容状态schema为13；迁移包schema 3仍兼容旧schema 1/2包。
- 必须继续持久化`data`和`temp`。
- 源码运行要求Node.js 24。
- 外接AList不会自动升级；内置Compose使用`v3.61.0`，升级前应备份AList数据并验证WebDAV动作。

## v2.4.0

- 运行状态和任务队列迁移到SQLite。
- 下载、上传、确认、历史上传与画质重调统一持久任务。
- BBDown固定fork Release并通过aria2断点续传。
- 增加Web/APP接口模式、B站风控冷却和上传两阶段确认。

完整版本历史见仓库中的[CHANGELOG.md](https://github.com/minori0721/Bili-favorites-backup/blob/main/CHANGELOG.md)和[Git标签](https://github.com/minori0721/Bili-favorites-backup/tags)。

::: warning 回滚旧镜像
如果目标旧镜像仍读取`state.json`，先停止当前程序并使用离线脚本从SQLite导出兼容JSON。不要让新旧镜像同时使用同一数据目录。
:::
