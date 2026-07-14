# 日志

BFB提供队列看板、精简输出、原始输出和调试模式。常规网页日志写入`data/logs.json`；解析失败时的BBDown Debug日志位于`data/debug/*.log`。

## Debug日志轮转

默认同时遵守三项上限，任一超出就从最旧完整`.log`开始删除：

- 保留14天。
- 最多200个文件。
- 总计最多256 MiB。

可用环境变量覆盖：

```dotenv
BFB_DEBUG_LOG_RETENTION_DAYS=14
BFB_DEBUG_LOG_MAX_FILES=200
BFB_DEBUG_LOG_MAX_MIB=256
```

非法值会回退默认值并输出安全警告。轮转只处理`data/debug`直属完整`.log`，不跟随符号链接，也不删除未知文件。

## 分享日志前

统一脱敏器会清除Authorization、Cookie、Set-Cookie、token、CSRF和URL凭据，但日志仍可能包含BVID、文件名、目录和接口类别。公开前应人工检查，不要上传整个`data`目录或迁移包。

## 容器日志

```bash
docker compose logs --since=30m app
docker compose logs --tail=200 alist
```

先区分错误来自B站、BBDown/aria2、BFB调度器还是AList/WebDAV，再决定处理方向。
