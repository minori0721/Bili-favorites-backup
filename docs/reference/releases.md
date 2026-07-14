# 版本与升级记录

文档导航中的版本号自动读取仓库根目录`package.json`，无需在站点配置中重复修改。

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
