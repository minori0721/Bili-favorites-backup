# 更新镜像

稳定版使用`latest`，测试版使用`dev`，版本标签使用`v*.*.*`。生产部署建议固定版本标签；想跟随稳定分支时再使用`latest`。

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 app
```

`docker compose up -d`会用已拉取镜像重建需要更新的容器，不会删除持久化目录。

## 更新前检查

- `data/`、`temp/`和内置AList的`alist/`确实挂载到宿主机。
- 阅读[版本与升级记录](../reference/releases)中的迁移说明。
- 涉及AList版本变化时，先备份`alist/`并阅读[AList升级](../alist/upgrade)。
- 大版本回滚前先导出旧镜像可读取的JSON快照。

## 更新后检查

1. 顶部版本与预期镜像一致。
2. 容器没有反复重启。
3. SQLite完整启动，持久任务和冷却恢复。
4. 队列没有同一BV的立即失败循环。
5. AList上传与远端确认正常。

拉取失败不会替换当前运行容器；看到旧容器仍在运行并不代表更新成功。
