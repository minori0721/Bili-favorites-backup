# 选择AList接入方式

BFB通过AList的WebDAV接口上传、列出、移动、删除和核验文件。你可以使用Compose内置AList，也可以连接已有实例。

| 方式 | 优点 | 需要注意 |
| --- | --- | --- |
| 内置AList | 部署简单，容器内地址固定 | 必须单独持久化并备份`alist/` |
| 已有AList | 复用现有存储和账号 | 网络、HTTPS、反向代理与权限需自行保证 |

BFB不会自动升级外部AList，也不会直接管理AList数据库。页面中的“清理数据”只处理BFB的`data`与`temp`，不会删除AList数据目录。

继续阅读[使用内置AList](./built-in)或[接入已有AList](./existing)。
