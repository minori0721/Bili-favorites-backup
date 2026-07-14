# 容器重启恢复

BFB通过SQLite任务租约、下载会话和aria2控制文件恢复中断工作。重启后短时间没有新卡片，不一定是丢任务，调度器可能在等待`not_before`、冷却截止时间或任务租约过期。

## 正常重启

```bash
docker compose restart app
docker compose logs --tail=150 app
```

SIGTERM后应用停止领取新任务，终止BBDown/aria2并等待最多20秒落盘，再释放可释放租约、checkpoint WAL并关闭数据库。

## 检查恢复

- `data/bfb.sqlite`存在且完整打开。
- `temp/<BVID>/.bfb-download.json`仍在。
- aria2控制文件与对应轨道匹配。
- 队列恢复统计显示待下载、待上传、待确认或到期重试。
- 风控、用户冷却和上传熔断没有被重启清空。

## 不要这样做

- 不要在应用运行时删除SQLite、WAL或SHM。
- 不要手动把`downloading`改成`downloaded`。
- 不要删除`.aria2`后期待继续字节级续传。
- 不要用重启绕过B站三分钟冷却。

无法识别的旧残片会保留供人工预览，不会被自动接管或删除。
