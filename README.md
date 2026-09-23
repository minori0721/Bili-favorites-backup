# BFB · B站收藏夹归档

将B站收藏持续备份到 AList / OpenList，让已经保存的视频、封面和收藏记录，在源视频失效后仍可查看。

[快速部署](#快速部署) · [完整文档](https://minori0721.github.io/Bili-favorites-backup/) · [最新版本](https://github.com/minori0721/Bili-favorites-backup/releases/latest) · [更新记录](CHANGELOG.md)

![BFB主界面](docs/public/screenshots/dashboard-desktop.png)

Bili-favorites-backup（BFB）是一个自托管的收藏夹备份工具。它定时检查收藏、下载视频、上传网盘并核验归档结果；你可以在自己的归档库中搜索和播放，不必依赖视频仍在B站可见。

**留档优先保留旧版，不是持续追新。** 已有完整旧归档时，普通同步不会自动用新版覆盖。BFB只能保护已经成功保存的内容，不能找回从未备份的失效视频。

## 能做什么

| 能力 | 使用体验 |
| --- | --- |
| 自动归档 | 多账号、多收藏夹定时同步，通过标准WebDAV连接 AList / OpenList |
| 旧档保护 | 保留收藏历史与归档封面，新尝试失败不会替换已有归档 |
| 断点与恢复 | 下载断点、上传确认和恢复任务持久保存；可自动处理的异常在后台复核，需要决定的事项集中到“待处理” |
| 归档播放 | 搜索、筛选和连续播放已验证归档；浏览归档库不请求B站或扫描网盘目录 |
| 在线手动归档 | 浏览在线收藏、订阅合集、追番追剧、稍后再看和历史；可解析为视频的条目支持手动归档 |
| 画质与编码 | 设置HEVC / AVC / AV1偏好；手动归档和换规格重试可探测可用组合、预计大小，并严格选择已有源 |

播放优先使用合适的网盘直链，不可用时回退BFB代理。**不提供转码**，选择HEVC或AV1不会把AVC重新编码；播放能力也取决于浏览器。

## 快速部署

当前镜像支持 **Linux amd64**。下面两种方式任选一种，保存为 `docker-compose.yml`。

### 已有 AList / OpenList

只运行BFB，不会创建或修改你的存储服务：

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      ADMIN_USER: ${ADMIN_USER:-admin}
      ADMIN_PASS: ${ADMIN_PASS:?请在.env中设置ADMIN_PASS}
      SESSION_SECRET: ${SESSION_SECRET:?请在.env中设置SESSION_SECRET}
      ALLOW_COOKIE_EXPORT: "false"
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
```

<details>
<summary>还没有存储服务：同时部署BFB与AList</summary>

使用下面这份完整Compose，替代上面的示例。AList固定版本沿用项目内置方案，网盘需要在AList中另行添加。

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      ADMIN_USER: ${ADMIN_USER:-admin}
      ADMIN_PASS: ${ADMIN_PASS:?请在.env中设置ADMIN_PASS}
      SESSION_SECRET: ${SESSION_SECRET:?请在.env中设置SESSION_SECRET}
      ALLOW_COOKIE_EXPORT: "false"
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
      PUID: "0"
      PGID: "0"
      UMASK: "022"
      ALIST_ADMIN_PASSWORD: ${ALIST_ADMIN_PASSWORD:?请在.env中设置ALIST_ADMIN_PASSWORD}
    volumes:
      - ./alist:/opt/alist/data
```

同时在下方 `.env` 中增加 `ALIST_ADMIN_PASSWORD`，设置另一个强密码。AList管理页面为 `http://服务器地址:5244`。

</details>

### 设置密码并启动

在同目录创建 `.env`，将占位文字替换为独立强密码和足够长的随机密钥，不要公开此文件。示例会在变量缺失或为空时拒绝启动，但不能识别你是否仍在使用占位文字。

```dotenv
ADMIN_PASS=请替换为独立强密码
SESSION_SECRET=请替换为足够长的随机字符串
```

```bash
docker compose pull
docker compose up -d
docker compose logs --tail=100 app
```

访问 **`http://服务器地址:3000`**，使用 `admin` 和你设置的密码登录。公网访问建议通过HTTPS反向代理，并限制管理端口的访问范围。

### 第一次归档

1. 在设置中填写BFB容器可访问的存储地址、WebDAV账号和归档目录。
2. 运行“只读检查存储连接”确认目录可读，然后登录B站账号。
3. 先手动归档一个小视频，验证下载、上传和远端确认流程，再选择需要自动同步的收藏夹。
4. 在任务中心看进度，在归档库查看已经完成的内容。

内置AList的通信地址为 `http://alist:5244`。外接服务请使用容器实际可达地址：`127.0.0.1` 指向BFB容器自身，`openlist` 这样的服务名仅在共享Docker网络中可解析。BFB自动处理 `/dav`，不要填成 `/dav/dav`；播放器的网页访问地址可单独设置。

详细步骤：[Docker部署](https://minori0721.github.io/Bili-favorites-backup/guide/docker) · [接入OpenList](https://minori0721.github.io/Bili-favorites-backup/alist/openlist) · [存储与权限](https://minori0721.github.io/Bili-favorites-backup/alist/storage)

## 数据保护与升级

**不要省略或清空持久化挂载。**

| 目录 | 保存内容 |
| --- | --- |
| `./data` | 数据库、账号与配置、归档证明、永久归档封面 |
| `./temp` | 下载断点、下载清单及尚未确认远端成功的本地成品 |
| `./alist` | 仅内置方案需要，保存AList配置与挂载信息 |

- 有效本地成品在远端尚未可靠确认时受到保护，不因缓存压力或任务失败自动释放。“停止本次尝试”不等于删除文件。
- 移除账号默认只移除登录，已有归档、封面和收藏历史保留；远端清理需单独确认。
- 归档封面不受在线缩略图缓存的自动淘汰影响；手动清理归档封面属于危险操作。
- 已有归档时，使用“迁移归档路径”调整目标目录，不要通过清空数据库或直接修改路径绕过保护。

升级BFB时保留挂载，只更新 `app` 服务：

```bash
docker compose pull app
docker compose up -d --no-deps app
docker compose logs --tail=100 app
```

顶部版本入口可查看正式版更新说明，**不会自动拉镜像或重启**。拉取失败时旧容器可能仍在运行，请以启动日志中的版本与提交确认更新结果。

`v2.6.2`保持SQLite schema 11、JSON状态schema 13和迁移包schema 3；当前 dev 的 `v2.6.3` 候选同样不新增配置或数据迁移。从 `2.6.1` 升级无需新增配置或数据迁移；更早版本迁移和回滚前请先备份并阅读[升级说明](https://minori0721.github.io/Bili-favorites-backup/operations/update)与[数据迁移](https://minori0721.github.io/Bili-favorites-backup/operations/migration)。

## 常见问题

**为什么上传后还在等待确认？**

网盘可能延迟显示文件，上传响应也不等于归档已经可靠完成。BFB按远端证据复核；`405`、超时等异常不会直接被当成“文件不存在”，也不会因此盲目重复上传。需要你决定时会显示在“待处理”。[恢复说明](https://minori0721.github.io/Bili-favorites-backup/features/recovery)

**视频在B站失效了怎么办？**

已有归档不受源站失效影响。尚未保存的内容会停止无意义下载，并按条件低频复核；重新取得有效详情和分P后可恢复归档。长期不可用会休眠，BFB不能保证源视频重新出现。

**HEVC视频为什么不能播放？**

浏览器或设备可能不支持该编码，切换代理不能解决解码问题。可用支持该格式的播放器打开；换编码重试只选择B站仍提供的源，不转码，也不保证源仍可下载。

**AList / OpenList之外的WebDAV能用吗？**

BFB使用通用WebDAV，不调用两者的私有REST API。但不同服务与网盘驱动支持的方法不同，不能保证所有后端兼容。普通上传不依赖MOVE，路径迁移等操作还有额外能力要求。[兼容范围](https://minori0721.github.io/Bili-favorites-backup/reference/compatibility)

## 安全与开发

- 使用独立强密码，妥善保管 `.env`、`data` 和迁移包，其中可能含账号凭据。不要直接公开日志或备份。
- 不需要导出B站Cookie时保持 `ALLOW_COOKIE_EXPORT=false`。HTTPS反向代理部署时设置 `COOKIE_SECURE=true`，纯HTTP不要开启。
- 仅备份你有权访问和保存的内容；BFB不绕过隐私、付费权限或审核限制。

| 镜像标签 | 用途 |
| --- | --- |
| `latest` | `main`稳定版 |
| `v2.6.3` | dev 候选版本，完成验收后再创建正式标签 |
| `v2.6.2` | 固定版本，便于可控升级 |
| `dev` | 开发测试版，不保证与稳定版一致 |

镜像仓库为 `minori0721/bili-favorites-backup`，当前仅发布 `linux/amd64`。源码使用Node.js 24：

```bash
npm ci
npm test
npm run build
```

项目固定BBDown fork与FFmpeg版本，不在构建时跟随上游master。`v2.6.2`稳定版内置 [BBDown bfb-2.0.5](https://github.com/minori0721/BBDown/releases/tag/bfb-2.0.5)；当前 dev 应用版本为 `v2.6.3`，镜像固定 [bfb-2.0.7](https://github.com/minori0721/BBDown/releases/tag/bfb-2.0.7)。两版均支持结构化媒体探测与互动视频完整可达片段清单；最终媒体信息以ffprobe为准。开发验证记录见 [DEV_NOTES](DEV_NOTES.md)。

## 鸣谢

- [BBDown](https://github.com/nilaoda/BBDown) · [BFB维护的fork](https://github.com/minori0721/BBDown)
- [AList](https://alist.nn.ci/)
- [OpenList](https://github.com/OpenListTeam/OpenList) · [官方文档](https://doc.oplist.org/)
- [Artplayer](https://artplayer.org/)
- [biliAPI](https://github.com/renmu123/biliAPI)
- [FFmpeg](https://ffmpeg.org/)
- [Bilibili API Collect](https://socialsisteryi.github.io/bilibili-API-collect/)
