# Dev 测试说明

本文只记录 `dev` 分支相对 `main` 的当前测试内容。确认稳定并合并到 `main` 时，把需要公开给用户的内容整理进 `CHANGELOG.md`，然后重置本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.4.0`
- 当前 dev 变更：暂无，当前代码与 `main` 发布内容保持一致。
- 镜像预期：推送 `dev` 分支后发布 `minori0721/bili-favorites-backup:dev`；`latest` 仍只由 `main` 分支发布。

## 当前 dev 变更

暂无。

## 测试重点

- 新增 dev 变更后，在这里记录需要重点验证的路径。
- 默认回归：`npm test`、`npm run build`。

## 建议测试命令

```bash
npm ci
npm test
npm run build
npm --prefix . audit --omit=dev
```

> 注意：`npm audit --omit=dev` 可能会报告依赖传递风险；自动修复前需要确认不会降级或破坏主依赖。

## 已知问题 / 暂缓项

暂无新增项；正式版本已知事项见 `CHANGELOG.md` 的 `2.4.0` 条目。

## 合并到 main 时的处理

1. 在 `dev` 环境完成本轮变更对应的测试路径。
2. 把本文件「当前 dev 变更」整理为 `CHANGELOG.md` 的正式版本条目。
3. 确认 README 只保留稳定用户需要看的内容，dev 测试细节继续留在本文件。
4. 合并 `dev` 到 `main` 后，确认 GitHub Actions 只为 `main` 发布 `latest`。
5. 如果要保留下一轮 dev 测试，把本文件重置为新的 dev 状态。
