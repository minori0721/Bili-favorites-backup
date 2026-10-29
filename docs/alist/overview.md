# 选择 AList / OpenList 接入方式

BFB通过 AList 或 OpenList 的 WebDAV 接口上传、列出、移动、删除和核验文件。你可以使用 Compose 内置 AList，也可以连接已有 AList 或 OpenList 实例。

| 方式 | 优点 | 需要注意 |
| --- | --- | --- |
| 内置AList | 部署简单，容器内地址固定 | 必须单独持久化并备份`alist/` |
| 已有 AList / OpenList | 复用现有存储和账号 | 确认 BFB 容器可访问 WebDAV，账号可读写目标目录 |
| 已有OpenList | 可使用 OpenList 的持续维护版本与现有挂载 | 授予挂载管理权限，先用小视频确认上传、播放和清理正常 |

BFB不会自动升级外部 AList 或 OpenList，也不会直接管理它们的数据库。页面中的“清理数据”只处理 BFB 的`data`与`temp`，不会删除远端存储服务的数据目录。

继续阅读[使用内置 AList](./built-in)、[接入已有 AList / OpenList](./existing)或[接入 OpenList](./openlist)。
