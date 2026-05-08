# 更新日志 (Changelog)

## [1.0.0] - 2026-05-08

### ✨ 新增功能

#### 分页加载与优化
- **bili.ts**: 新增 `listFavoriteItemsPage()` 函数支持单页拉取收藏夹视频
- **bili.ts**: 添加 `BiliRiskOrLoginError` 异常类，区分风控/登录失效错误
- **bili.ts**: 多页拉取时加入 300ms 节流延迟，避免 B 站 API 限流
- **web.ts**: 收藏夹详情弹窗改为分页滚动加载，支持大收藏夹浏览
- **web.ts**: 下架清单支持分页游标遍历多个收藏夹

#### 后端 API 增强
- **index.ts**: `/api/users/:id/favorites/:mediaId/items` 改为分页返回，新增 60 秒缓存
- **index.ts**: `/api/users/:id/unavailable` 支持游标分页，逐页扫描下架视频
- **index.ts**: 登录时自动保存 `accessToken`，供 Hi-Res/杜比音效下载使用
- **index.ts**: 新增 `/api/state` 端点，返回已处理和失败视频的状态
- **index.ts**: 新增 `/api/cache/clear` 端点，支持手动清除收藏夹详情缓存
- **index.ts**: 日志流式传输 `/api/logs/stream` (Server-Sent Events)

#### 下载控制增强
- **downloader.ts**: BBDown 画质参数规范化（8K、4K、1080P 等）
- **downloader.ts**: BBDown 编码参数标准化（HEVC、AVC、AV1）
- **downloader.ts**: Hi-Res/杜比音效下载时需要 APP access token，避免失败
- **downloader.ts**: `perVideoDelaySeconds` 改为传给 `--delay-per-page`，实现视频间节流
- **downloader.ts**: 永久失败识别（视频删除、下架、不可见等），跳过重试

#### 状态管理与重试
- **scheduler.ts**: 同步队列去重更完善，避免重复下载
- **scheduler.ts**: 跳过已失败的视频任务，不重复排队
- **scheduler.ts**: 永久失败写入 state.json，支持失败原因记录
- **state.ts**: 新增 `failedByUser` 字段，记录失败视频及原因
- **state.ts**: `markFailed()` 支持记录永久失败标记和失败描述

#### UI/UX 改进
- **web.ts**: 修复中文文案乱码，所有文本显示正常
- **web.ts**: 收藏夹详情显示视频缩略图、UP主、BV号
- **web.ts**: 下架清单支持筛选（未上传 / 已上传）
- **web.ts**: 日志支持"精简模式"和"原始输出"双模式切换
- **web.ts**: 一键重命名网盘文件功能
- **web.ts**: 模板标签拖拽排序，自定义视频命名格式

### 🔧 修复与改进

#### 代码质量
- **queue.ts**: Task 基类添加动态属性支持 (`[key: string]: any`)，避免 `as any` 类型转换
- **web.ts**: 数据验证加强，检查 `Array.isArray(data.items)` 防止异常结构
- **web.ts**: 错误处理改进，详细显示 API 错误信息
- **web.ts**: 乱码修复，将 `'δ֪'` 替换为 `'未知'`
- **index.ts**: accessToken 提前定义，避免 falsy 值检查失败
- **index.ts**: 游标验证加强，边界检查防止恶意输入（folderIndex、page < 10000）

#### 类型安全
- **bili.ts**: 完整的 TypeScript 类型定义（BiliUserInfo、FavoriteItem、FavoriteItemsPage 等）
- **index.ts**: 所有 API 端点的请求/响应类型明确
- **downloader.ts**: 编码/画质类型映射完善

### 📊 配置与性能

- **config.ts**: 支持视频间延迟、并发下载/上传配置
- **config.ts**: 支持任务重试次数和重试间隔调节
- **config.ts**: BBDown 编码/画质/Hi-Res/杜比选项完整支持
- **scheduler.ts**: 可配置的轮询间隔、并发数，支持热更新

### 🔐 安全性

- **bili.ts**: 风控/登录失效检测，区分处理不同错误
- **index.ts**: 游标输入验证，防止越界或恶意分页
- **users.ts**: Cookie 存储结构化，支持 accessToken 分离存储

### 📝 开发工具

- 完整 TypeScript 支持 (tsc 编译无错误)
- ESLint 配置 (eslint.config.mjs)
- 开发命令：`npm run dev`、`npm run build`、`npm start`
- 登录脚本：`npm run login`

### ⚡ 性能优化

- 300ms 多页拉取节流，避免 API 限流
- 60 秒收藏夹详情缓存，减少冗余请求
- Server-Sent Events 流式日志，减少轮询开销
- 前端分页虚拟滚动，大列表性能优化

### 📦 依赖清单

- **@renmu/bili-api**: 2.13.2（Bilibili API 客户端）
- **express**: 4.22.1（Web 框架）
- **express-session**: 1.19.0（会话管理）
- **qrcode**: 1.5.4（二维码生成）
- **webdav**: 5.10.0（WebDAV 协议）
- **typescript**: 5.9.3（类型检查）
- **tsx**: 4.21.0（TypeScript 执行）

### ⚠️ 已知限制

- `perVideoDelaySeconds` 当前实现为分 P 间延迟（`--delay-per-page`），若需严格视频级节流，需在队列层额外加延迟
- 依赖 @renmu/bili-api 中存在 XML 注入漏洞（不影响当前业务，可通过 `npm audit fix --force` 升级）

### 🔄 升级指南

#### 从之前版本升级：
1. 备份 `data/` 目录（用户数据、配置、状态）
2. 更新代码：`git pull origin main`
3. 安装依赖：`npm install`
4. 构建：`npm run build`
5. 启动：`npm start`

#### 配置迁移：
- 新字段自动补默认值，无需手动修改 config.json
- 旧的 state.json 兼容，自动扩展 `failedByUser` 字段

### 📞 反馈与贡献

欢迎提交 Issue 和 Pull Request。

---

**发布时间**: 2026-05-08  
**版本**: 1.0.0  
**状态**: 生产就绪 ✅
