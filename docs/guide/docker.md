# 5分钟 Docker 部署

## 配置参考

**配置：** 仅运行 BFB 时，可从 **1 核 CPU、512 MB 内存**起步，下载、上传建议各设为 1 个并发。

**内存占用：** 主进程空闲时约 **200 MB**，下载、合并和上传时会增加。

**磁盘空间：** 一般建议剩余 **10 GB**，按视频大小和待上传文件适当增加；空间较小时，调低下载、上传并发及本地缓存软上限。

## 创建 Compose 文件

下面的 Compose 同时运行 BFB 和固定版本 AList。先创建空目录，在其中保存`docker-compose.yml`。这份内置示例仍使用 AList；如果你已经运行 OpenList，请只部署 `app` 服务，再按[接入 OpenList](../alist/openlist)填写 WebDAV 地址和权限。

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=${ADMIN_USER:-admin}
      - ADMIN_PASS=${ADMIN_PASS:-please-change-admin-pass}
      - SESSION_SECRET=${SESSION_SECRET:-please-change-session-secret}
      - ALLOW_COOKIE_EXPORT=${ALLOW_COOKIE_EXPORT:-false}
      - TRUST_PROXY=${TRUST_PROXY:-false}
      - COOKIE_SECURE=${COOKIE_SECURE:-false}
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
      - ./alist:/app/alist:ro
    depends_on:
      - alist

  alist:
    image: xhofe/alist:v3.61.0
    container_name: bili-favorites-backup-alist
    restart: unless-stopped
    ports:
      - "5244:5244"
    environment:
      - PUID=0
      - PGID=0
      - UMASK=022
      - ALIST_ADMIN_PASSWORD=${ALIST_ADMIN_PASSWORD:-please-change-alist-pass}
    volumes:
      - ./alist:/opt/alist/data
```

## 设置密码

在同一目录创建`.env`，至少替换下面三项：

```dotenv
ADMIN_PASS=换成独立的强密码
SESSION_SECRET=换成足够长的随机字符串
ALIST_ADMIN_PASSWORD=换成另一个强密码
```

不要提交或公开`.env`。如果确实需要网页导出B站Cookie，再显式设置`ALLOW_COOKIE_EXPORT=true`。

::: warning 反向代理部署与更新提醒
直接通过 IP 或域名使用 HTTP 时，保持 `TRUST_PROXY=false`、`COOKIE_SECURE=false`。通过宝塔 / Nginx 的 HTTPS 反向代理访问时，必须将 `TRUST_PROXY` 设置为 BFB 实际收到连接的代理 IP 或网段，并设置 `COOKIE_SECURE=true`；Docker 中的连接来源可能是桥接网关，不能直接猜成 `127.0.0.1`。

新版本不再默认信任一跳代理。已有反代部署更新前也要检查这两项，详见[反向代理与登录安全](../operations/security#反向代理与登录安全)。自定义 Compose 必须加入上面的两个 `environment` 条目，仅在 `.env` 写值不会自动传入容器。
:::

## 启动

```bash
docker compose pull
docker compose up -d
docker compose ps
```

访问：

- BFB：`http://服务器地址:3000`
- AList：`http://服务器地址:5244`

首次拉取可能受Docker Hub网络质量影响。如果出现超时，先看[Docker Hub拉取超时](../troubleshooting/docker-hub)。

::: danger 不要省略挂载
`data:/app/data`保存SQLite与账号，`temp:/app/temp`保存断点和待补传文件。缺少任一挂载都会破坏容器更新后的恢复能力。
:::

## 查看启动状态

```bash
docker compose logs --tail=100 app
```

启动日志会显示应用版本、构建分支与提交、BBDown Release及固定源码提交。弱管理员密码、默认会话密钥或Cookie导出开启时也会出现不包含实际值的安全警告。

下一步：[首次登录](./first-login)。

## 版本检查与发布说明

进入主页后，BFB会在后台检查更新。正式版检查最新正式发布；dev 检查开发预览，同时提供正式版信息。顶部版本按钮可打开当前与最新版本的发布说明。

检查由服务端读取本项目公开的 GitHub Release，无需配置 GitHub Token。网络暂时不可用时会保留上次成功结果和检查时间，备份任务照常运行；也可以在窗口里点击“检查更新”。

发现更新后，同一浏览器对同一发布只轻提示一次，版本按钮右侧保留更新标记。开发版按提交区分新构建。

窗口顶部对照当前和可用版本，下方切换“最新版本说明 / 当前版本说明”。dev 可以切换查看正式版；需要转为稳定版时，在宝塔或 Compose 中更换镜像标签。

当前版本说明随镜像保存，最新说明从 GitHub 获取；旧构建缺少内置说明时，可打开对应提交记录。

开发预览页持续汇总上一个正式版以来的新增、变更和修复，内容来自 CHANGELOG 的 `Unreleased`。它反复更新同一个页面，请看标题中的提交和正文更新时间判断是否更新。

版本窗口只负责展示和提醒，实际升级请使用宝塔或[Compose 更新步骤](../operations/update)。查询实现与维护者发布规则见[开发指南](../development/architecture#版本查询与发布说明)。
