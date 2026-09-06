# 5分钟 Docker 部署

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

## 版本检查与发布说明

点击主页顶部版本标签打开“版本与更新”。正式标签及main构建按版本比较；dev和本地构建只展示正式版参考，不表示dev镜像已经有更新。

检查由服务端访问本项目公开GitHub Release，不需要GitHub Token，也不会读取B站或存储凭据。正常只查询一次Latest；若Latest属于FFmpeg等工具，则最多读取3页发布列表，每页30项。总请求时间8秒，单响应1MB、总响应2MB；未完整或异常结果不会声明“已是最新”。成功缓存6小时，手动刷新至少间隔1分钟；重启后缓存重新建立。

发布说明支持标题、列表、代码及安全HTTP/HTTPS链接，不执行HTML、不加载远端图片。空正文提供对应标签的CHANGELOG链接，超过24000字符显示截断提示。网络、限流或格式错误会保留上次成功结果和时间，不影响同步或进入待处理。

应用不自动拉镜像、更新编排或重启容器。升级仍由管理员阅读该版本注意事项后，通过原有宝塔或Compose流程执行。Release不需要BFB二进制附件，镜像由镜像仓库提供；BBDown和FFmpeg工具包仍保留其独立附件。

### 维护者发布规则

- 继续使用现有dev验证、正式版本标签及main发布流程；不要为发布说明移动或重打历史标签。
- 标签必须为`vX.Y.Z`，并与package版本及CHANGELOG章节一致。CHANGELOG应记录主要变化、升级注意、数据兼容与已知问题，发布正文从标签对应章节生成，不取dev“未发布”内容。
- `Docker Publish`中新增的Release任务只在正式标签镜像成功后运行，单独授予`contents: write`；重跑保留已有Release，历史版本不会把Latest退回。此流程从v2.5.5开始生效，不追溯执行旧工作流。
- 工具包发布使用工具前缀，并显式设置`--latest=false`。不得搬迁或删除历史附件，否则旧镜像构建可能无法下载固定依赖。
- 2026-09-06补建的BFB `v2.5.4` Release来自既有标签`941a968`对应章节，标签与成功镜像不变；不是新版本发布。更早版本仍可从CHANGELOG及Git标签查看，没有批量补建历史Release。
