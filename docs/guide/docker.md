# 5分钟 Docker 部署

下面的Compose同时运行BFB和固定版本AList。先创建空目录，在其中保存`docker-compose.yml`：

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
