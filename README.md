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

2. 打开网页

- 应用：http://localhost:3000
- rclone Web UI：http://localhost:5572

3. 在 rclone Web UI 里创建 remote

- 配置会写入 `./rclone/rclone.conf`
- 以后重启容器会自动复用该配置

默认登录：`admin / admin`（请在 compose 环境变量里修改）

管理员环境变量（必填）：

- `ADMIN_USER`
- `ADMIN_PASS`
- `SESSION_SECRET`

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

- Cookie 保存在 `data/users.json`
- 下载缓存位于 `temp/`，上传后由 rclone move 自动清理
- 管理员登录由 `ADMIN_USER` / `ADMIN_PASS` 控制

## 参考资料 & 鸣谢

- biliAPI: https://github.com/renmu123/biliAPI
- BBDown: https://github.com/nilaoda/BBDown
- rclone: https://rclone.org/
- Bilibili API Collect: https://socialsisteryi.github.io/bilibili-API-collect/
