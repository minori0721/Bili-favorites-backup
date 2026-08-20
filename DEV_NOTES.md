# Dev 测试说明

## 当前基线

- 基准版本：`v2.5.0`。
- 发布提交：`efa9a4b`（`发布 v2.5.0 OpenList 与上传恢复增强`）。
- SQLite：`user_version 10`；JSON 状态：schema 13；迁移包：schema 3。
- 当前 dev 固定 BBDown fork Release `bfb-2.0.2`，源码提交 `bd532f51f41da4cc63b991e431add7f84b28db2a`，Linux x64 ZIP SHA256 `bd7327f9aae88279b5b89dfec3118aad6488d21c5d527fe54917aca53f12874c`。
- 当前 dev 在发布基线外包含 BBDown 2.0.2 更新及本轮远端路径、上传安全和画质升级恢复修复。

## 发布验证

```text
npm ci
npm test
npm run test:ui
npm run build
npm --prefix docs ci
npm --prefix docs run docs:build
git diff --check
npm audit --omit=dev
npm --prefix docs audit --omit=dev
```

- `npm test`：346 项，345 项通过；1 项因本机缺少 `aria2c` 跳过，0 项失败。
- `npm run test:ui`：42 项，24 项通过，18 项按环境条件跳过，0 项失败。
- 根项目和文档站构建通过，`git diff --check` 通过。
- 根项目生产依赖审计：11 项（2 低危、3 中危、6 高危、0 严重）；文档站：0 项。
- Docker Publish 和 Docs Pages 已由 `main` 与 `v2.5.0` 标签工作流验证成功。

## 后续规则

- 新改动追加到 CHANGELOG 的“未发布”章节，并在本文件补充专项测试和已知边界。
- 发布时 `main` 仅使用 `--ff-only` 接收 `dev`，不挑选、压缩或改写已验证提交。
- 发布完成后将 `dev` 快进到发布提交，再重建本文件；正式发布说明不保留本文件。
- 本次未更新 Aliyun 服务器；`output/` 为本地未跟踪测试产物，不属于发布内容。
