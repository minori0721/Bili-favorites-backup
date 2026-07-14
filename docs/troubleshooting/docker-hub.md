# Docker Hub拉取超时

典型错误：

```text
Get "https://registry-1.docker.io/v2/": i/o timeout
```

这表示Docker守护进程没有在超时前连上Docker Hub，与BFB应用逻辑无关。拉取失败时旧容器可能仍显示`Running`，但镜像没有更新。

## 先确认

```bash
docker compose pull
docker image inspect minori0721/bili-favorites-backup:latest
docker compose ps
```

如果`pull`明确失败，不要把“旧容器继续运行”当作更新完成。

## 常见处理

- 稍后重试，避开网络波动。
- 检查服务器DNS、出站443、代理和Docker daemon代理配置。
- 使用你信任的Docker镜像加速或中转，不要随意使用来源不明的镜像。
- 在网络正常的机器拉取后导出镜像，再通过受控方式传到服务器。

不要反复执行`docker compose down`后再拉取；旧容器本来可以继续服务，先保持它运行更稳妥。
