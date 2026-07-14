# 升级与备份AList

内置Compose固定AList版本，不会自动跟随`latest`。升级前先停止相关容器并备份AList数据目录。

```bash
docker compose stop app alist
```

备份宿主机上的`alist/`后，再修改镜像标签并拉取。不要只备份BFB的`data/`，AList存储驱动配置不在BFB数据库里。

## 升级后验收

至少验证：

- 登录AList后台。
- 列出BFB目标目录。
- 上传一个测试文件并读取准确大小。
- 同目录MOVE重命名。
- 下载并比对文件。
- 删除测试文件。

确认以上动作后再启动BFB批量任务。外接AList的升级完全由你管理，BFB不会改动其镜像或数据。

::: info 当前边界
Compose中的AList `v3.61.0`并不代表所有网盘驱动都已由本项目真实验证。驱动兼容性取决于AList版本、存储提供方与账号权限。
:::
