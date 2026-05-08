# Bili-favorites-backup

一个全自动化 Node.js 服务：定时监控 Bilibili 收藏夹，使用 BBDown 高清下载，并通过 AList 直连 WebDAV 自动同步归档到各类国内网盘（如阿里云盘、夸克、百度网盘、115等）。

## ✨ 核心特性

- **🟢 纯粹的 Miku 绿清新主题**：焕然一新的现代化 Web UI，全平台自适应，极具质感。
- **📺 稳定 TV 端登录**：采用 Bilibili TV 端 API 进行扫码登录，有效绕过 Web 端的严苛风控限制。
- **⚡ 高性能任务队列**：内置生产-消费队列模型，支持**自定义并发数**与**失败智能重试**，杜绝卡死阻塞。
- **🎞️ 深度定制 BBDown**：网页端直观选择视频编码 (HEVC/AVC/AV1)、强制画质 (4K/8K)、以及下载 Hi-Res 和杜比音效。
- **☁️ AList 极简挂载体验**：彻底告别繁琐的命令行配置，自带 AList 面板，全中文可视化挂载你的任意网盘。
- **📦 Docker 一键部署**：开箱即用，所有配置皆可通过前端 Web 面板热重载生效。

## 🚀 快速开始（Docker）

### 方式一：直接拉取镜像部署（推荐）

如果你不想在本地编译代码，可以直接新建一个 `docker-compose.yml` 文件，填入以下内容：

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASS=admin
      - SESSION_SECRET=change-me
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
    depends_on:
      - alist

  alist:
    image: xhofe/alist:latest
    container_name: bili-favorites-backup-alist
    restart: always
    volumes:
      - ./alist:/opt/alist/data
    ports:
      - "5244:5244"
    environment:
      - PUID=0
      - PGID=0
      - UMASK=022
      - ALIST_ADMIN_PASSWORD=admin123  # 这里是你的 AList 初始管理员密码
```

然后执行：
```bash
docker compose up -d
```

### 方式二：克隆源码本地编译构建

如果你修改了源码或者想用最新未经推送的代码：

```bash
docker compose up -d --build
```

### 2. 日常更新镜像与代码

如果拉取了新代码，请使用以下命令重启并重新构建镜像：

```bash
docker compose down
docker compose up -d --build
```

3. **进入面板**

- 主控制面板：http://localhost:3000
- AList 管理后台：http://localhost:5244

默认管理员登录：`admin / admin`（强烈建议在 docker-compose 中修改环境变量 `ADMIN_USER` 和 `ADMIN_PASS`）。

## ⚙️ AList 网盘挂载指南

本系统使用 AList 的 WebDAV 接口进行原生上传。
1. 访问 AList 面板（默认 http://localhost:5244 ），使用初始默认账号 `admin` 和密码 `admin123` 登录（你可以在 docker-compose 的 `ALIST_ADMIN_PASSWORD` 中修改此初始密码）。
2. 在 AList 的【存储】页面中添加你的目标网盘（例如阿里云盘，挂载路径设为 `/阿里云盘`）。
3. 回到主控制面板的 **[全局设置]**，将 AList 目标存储路径设置为 `/阿里云盘/bili-backup/videos`。系统便会自动将下载好的视频推送到你的网盘！

本系统完全抛弃了繁琐的 JSON 手写编辑。所有配置均在 Web 面板在线修改并实时生效：

- **基础轮询**：设定自动检测新收藏视频的时间间隔（分钟）。
- **云盘目录映射**：提供三种整理模式：
  - `用户名 / 收藏夹名 / 视频`
  - `收藏夹名 / 视频`
  - `仅视频文件`
- **下载与上传并发**：独立设置下载和上传的同时进行数量（为防止风控，建议下载并发保持为 1）。
- **视频高级参数**：自由选择是否需要 8K 画质和全景杜比音效。

## 🔧 本地开发

本系统基于 Node.js 环境开发：

```bash
npm install
npm run dev
```

## ⚠️ 常见问题

**1. 下载被限速或拦截**
高频下载极易触发 B 站安全风控，请适当调大 **失败重试间隔** 以及 **视频间延迟时间**。系统内部使用了任务队列，遇到网络截断会自动将该任务送入等待队列稍后重试，不会影响其他账号的工作。

## 💖 鸣谢

- biliAPI: https://github.com/renmu123/biliAPI
- BBDown: https://github.com/nilaoda/BBDown
- AList: https://alist.nn.ci/
- Bilibili API Collect: https://socialsisteryi.github.io/bilibili-API-collect/
