# 升级与备份 AList / OpenList

内置 Compose 固定 AList 版本，不会自动跟随 `latest`。外接 AList 或 OpenList 由你单独维护。升级前先停止相关容器并备份对应的数据目录。

```bash
docker compose stop app alist
```

备份宿主机上的 `alist/` 或 OpenList 数据目录后，再修改镜像标签并拉取。不要只备份 BFB 的 `data/`，远端存储驱动配置不在 BFB 数据库里。

## 升级后验收

至少验证：

- 登录 AList / OpenList 后台。
- 列出BFB目标目录。
- 上传一个测试文件并读取准确大小。
- 同目录MOVE重命名。
- 下载并比对文件。
- 删除测试文件。

确认以上动作后再启动 BFB 批量任务。外接 AList / OpenList 的升级完全由你管理，BFB 不会改动其镜像或数据。

::: info 当前边界
Compose 中的 AList `v3.61.0`以及外接 OpenList beta 都不代表所有网盘驱动已由本项目验证。驱动兼容性取决于服务版本、存储提供方、WebDAV 权限与反向代理配置。
:::
