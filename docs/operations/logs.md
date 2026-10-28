# 日志

BFB提供队列看板、精简输出、原始输出和调试模式。常规网页日志写入`data/logs.json`；解析失败时的BBDown Debug日志位于`data/debug/*.log`。

网页日志保留最近 500 条，普通写入按 300 毫秒窗口合并，在后台写入临时文件后原子替换。退出时保存最后一批日志并等待旧写入清理；清空或导入会使旧写入失效，避免旧日志重新出现。突然断电仍可能丢失最后一个写入窗口内的日志，归档任务和恢复证据的持久化规则不受影响。

实时日志对每个连接限制等待发送的数据；连接长期接收不过来时会断开并自动重连。重连后重新展示最近日志，不重复追加历史；超过历史保留范围的日志不保证补齐。这不会中断后台备份任务。

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

先区分错误来自B站、BBDown/aria2、BFB调度器还是 AList / OpenList WebDAV，再决定处理方向。
