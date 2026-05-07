# Bili-favorites-backup

一个 Node.js 服务：定时监控 Bilibili 收藏夹，使用 BBDown 下载并通过 rclone 上传归档。

## 功能

- 多用户 Bilibili 扫码登录
- 每个用户可多选收藏夹
- 串行下载 + 上传，降低风控风险
- 可配置轮询间隔与上传层级
- Docker 一键部署 + rclone Web UI

## 快速开始（Docker）

1. 直接启动

```bash
docker compose up -d --build
```

如果你想直接使用 Docker Hub 镜像：

```bash
docker run -d \
	--name bili-favorites-backup \
	-p 3000:3000 \
	-v $(pwd)/data:/app/data \
	-v $(pwd)/temp:/app/temp \
	-v $(pwd)/rclone/rclone.conf:/root/.config/rclone/rclone.conf:ro \
	-e ADMIN_USER=admin \
	-e ADMIN_PASS=admin \
	-e SESSION_SECRET=change-me \
	minori0721/bili-favorites-backup:latest
```

2. 打开网页

- 应用：http://localhost:3000
- rclone Web UI：http://localhost:5572

3. 在 rclone Web UI 里创建 remote

- 配置会写入 `./rclone/rclone.conf`
- 以后重启容器会自动复用该配置
- 如果 Web UI 报错 `Error reading tag file`，请为 rclone 指定可写缓存目录（见下文）

默认登录：`admin / admin`（请在 compose 环境变量里修改）

管理员环境变量（必填）：

- `ADMIN_USER`
- `ADMIN_PASS`
- `SESSION_SECRET`

## 镜像构建

GitHub Actions 会在推送 `main` 分支或打 tag（如 `v1.0.0`）时自动构建并推送镜像：

- `minori0721/bili-favorites-backup:latest`
- `minori0721/bili-favorites-backup:sha-<commit>`
- `minori0721/bili-favorites-backup:vX.Y.Z`

## 配置说明

所有设置都存放在 `data/config.json`，也可在网页 Settings 中修改。

- `pollIntervalMinutes`：轮询间隔（默认 10）
- `perVideoDelaySeconds`：每条间隔（默认 15）
- `rcloneDestination`：示例 `my_s3:bili-backup/videos`
- `uploadLayout`：`user-folder-video` | `folder-video` | `video-only`
- `rcloneWebUrl`：默认 `http://localhost:5572`

## 本地开发

```bash
npm install
npm run dev
```

可选 CLI 登录：

```bash
npm run login
```

## 备注

- 全面支持中文 UI 界面
- 深度修复了原 `@renmu/bili-api` 中二维码轮询事件监听的 Bug，彻底解决扫码后卡在“等待扫码...”的问题，并增加了容错处理
- Cookie 保存在 `data/users.json`
- 下载缓存位于 `temp/`，上传后由 rclone move 自动清理
- 管理员登录由 `ADMIN_USER` / `ADMIN_PASS` 控制
- 宿主机挂载目录会长期保留：即使删除容器，`data/`、`temp/`、`rclone/` 仍在；只有你手动删除这些目录，数据才会消失

## rclone Web UI 及缓存设定

考虑到安全性，项目中 rclone 默认配置了 `--rc-user admin --rc-pass admin`，您在访问 Web UI 时需使用此账号密码登录。你可以在 `docker-compose.yml` 中修改。

此外，部分环境下 rclone Web UI 会尝试写入 `/root/.cache/rclone/webgui/tag`，
如果容器内该目录不可写，会出现 `Error reading tag file`。

解决方案：为 rclone 指定可写缓存目录并挂载到宿主机，例如：

```yaml
  rclone:
    image: rclone/rclone:latest
    command: rcd --config /config/rclone/rclone.conf --rc-web-gui --rc-addr :5572 --cache-dir /config/rclone/cache --rc-user admin --rc-pass admin
    ports:
      - "5572:5572"
    volumes:
      - ./rclone:/config/rclone
      - ./rclone-cache:/config/rclone/cache
```

然后在宿主机创建目录：

```bash
mkdir -p ./rclone-cache
```

## 参考资料 & 鸣谢

- biliAPI: https://github.com/renmu123/biliAPI
- BBDown: https://github.com/nilaoda/BBDown
- rclone: https://rclone.org/
- Bilibili API Collect: https://socialsisteryi.github.io/bilibili-API-collect/
