# Dev 测试说明

本文只记录 `dev` 分支相对 `main` 的当前测试内容。确认稳定并合并到 `main` 时，把需要公开给用户的内容整理进 `CHANGELOG.md`，然后重置本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.2.2`
- 当前 dev 提交：`ae099f7 完善备份一致性与 dev 发布配置`
- 镜像预期：推送 `dev` 分支后发布 `minori0721/bili-favorites-backup:dev`；`latest` 仍只由 `main` 分支发布。
- 本轮定位：修复备份一致性、配置安全性、BBDown 凭据暴露、Docker dev 发布与部署文档。

## 当前 dev 变更

### 备份一致性

- 修复同一 BV 同时存在于多个收藏夹时，共享下载目录被第一个上传任务提前删除，导致后续收藏夹目录漏传的问题。
- 上传任务现在共享下载目录，所有目标目录上传结束后再统一清理本地文件。
- 上传没有产出远端文件记录时不再误标记为已上传/已验证，会回到可重试状态。
- AList 目录读取失败不再被当成空目录，避免网络或服务异常时误判远端文件全部缺失。
- 全量扫描完成后，会把本轮未再出现在对应收藏夹里的旧关系标记为非当前收藏，减少取消收藏后的展示误差。

### 配置与状态安全

- JSON 配置/状态读取失败时不再静默重置默认值，会保留 `.corrupt-*` 备份并抛错，避免配置或状态被悄悄清空。
- 默认文件名模板改为 `<videoTitle>-<bvid>`，降低不同视频同名导致远端对账混淆的概率。
- 已保存的旧模板如果缺少 `<bvid>`，启动时会自动迁移为追加 `<bvid>` 的模板。
- 后端配置保存增加字段白名单和范围校验，减少异常配置导致任务行为不可控。

### BBDown 与 B 站登录

- BBDown Cookie / APP access token 不再通过进程命令行参数传入，改为每次下载使用临时 `--config-file`，下载结束后删除。
- BBDown 标准输出、错误输出和 debug 日志会对 Cookie / access token 做脱敏。
- Hi-Res / 杜比音频优先级改走 `--encoding-priority`；清晰度优先级继续走 `--dfn-priority`。
- `1080P60` 映射修正为 BBDown 可识别的 `1080P 高帧率`。
- 命令行 `npm run login` 改为 TV 端扫码登录，与 Web 面板登录方式一致。
- B 站风控/登录异常识别范围扩大，覆盖更多 HTTP 状态码、API code 和中文错误文本。

### Web 安全与操作体验

- 登录成功后重新生成 session，降低 session fixation 风险。
- `/api` 下非 GET 请求增加同源校验，减少跨站请求误操作风险。
- Cookie 导出改为 POST 接口，并要求手动输入 `EXPORT_COOKIE` 确认；可通过 `ALLOW_COOKIE_EXPORT=false` 关闭。
- Session Cookie 支持 `COOKIE_SECURE=true`，便于 HTTPS 反代环境启用 secure cookie。
- 任务队列提高并发数后会立即填满可用并发槽，不再只启动一个新任务。

### Docker 与发布

- GitHub Actions Docker 发布支持 `dev` 分支：
  - `main` -> `latest`
  - `dev` -> `dev`
  - `v*.*.*` -> 对应版本标签
- Docker Node 基础镜像更新到 `node:20-bookworm-slim`，并保留 `NODE_IMAGE` 构建参数。
- BBDown 下载支持固定 `BBDOWN_VERSION` 和可选 `BBDOWN_SHA256` 校验，不再默认跟随 latest。
- AList 示例镜像从 `latest` 固定为 `xhofe/alist:v3.41.0`。
- Docker Compose 示例改用 `please-change-*` 环境变量默认值，但不会拒绝启动。

## 测试重点

### 必测路径

- Web 登录：TV 扫码登录、账号信息刷新、token 自动刷新。
- CLI 登录：`npm run login` 能保存 TV 登录信息，且 Web 面板可继续使用。
- 收藏夹扫描：普通自动轮询、手动立即同步、全量扫描并对账。
- 多收藏夹同 BV：同一个视频在多个收藏夹中时，每个对应 AList 目录都能上传文件。
- 下载上传失败回补：BBDown 解析失败、上传空结果、AList 临时异常后，下一轮能重新入队。
- AList 对账：远端文件存在、远端文件缺失、AList 临时不可用三种场景。
- 文件名模板：旧配置缺少 `<bvid>` 时启动后自动迁移；新配置保存时必须包含 `<bvid>`。
- Cookie 导出：需要输入 `EXPORT_COOKIE`；设置 `ALLOW_COOKIE_EXPORT=false` 后应禁止导出。
- Docker dev 镜像：`dev` 分支 workflow 应发布 `:dev`，不应覆盖 `:latest`。

### 建议测试命令

```bash
npm ci
npm run build
npm --prefix . audit --omit=dev
```

> 注意：当前 `npm audit --omit=dev` 会报告 `@renmu/bili-api` 传递依赖 `fast-xml-parser` 的中危项；自动修复会把 `@renmu/bili-api` 降到 `1.0.0`，属于破坏性变更，本轮未强行处理。

## 已知问题 / 暂缓项

- 尚未在真实 Docker 环境中本地构建验证；Docker 发布逻辑已通过 workflow 配置检查。
- 尚未做真实浏览器 UI 回归测试，需要在部署后手动验证 Web 面板主流程。
- `@renmu/bili-api` 的 `fast-xml-parser` 传递依赖仍有中危审计提示，当前未在项目主路径直接调用其弹幕 XMLBuilder 工具，后续等上游升级或单独评估依赖覆盖方案。
- 默认 `ADMIN_PASS` / `SESSION_SECRET` 只在文档和 compose 示例中提示修改，不做启动拒绝。

## 合并到 main 时的处理

1. 在 `dev` 环境完成上面的必测路径。
2. 把本文件「当前 dev 变更」整理为 `CHANGELOG.md` 的正式版本条目。
3. 确认 README 只保留稳定用户需要看的内容，dev 测试细节继续留在本文件。
4. 合并 `dev` 到 `main` 后，确认 GitHub Actions 只为 `main` 发布 `latest`。
5. 如果要保留下一轮 dev 测试，把本文件重置为新的 dev 状态。