# Dev 测试说明

## 当前基线

- 基准版本：`v2.4.6`，发布提交：`2da980b`。
- 当前dev与main没有额外代码差异；仅保留本文件作为下一轮开发记录。
- SQLite：`user_version 7`；JSON兼容状态：schema 13；迁移包：schema 3。
- BBDown固定为fork Release `bfb-2.0.1`，源码提交`fd926373dfe03d68bf84a1ad8a4ffbf402b00988`。

## 发布验证基线

```bash
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

- `v2.4.6`本地逻辑测试共277项：276项通过，1项仅因本机缺少aria2跳过；Playwright有效场景9项全部通过。
- 应用与文档构建通过。根生产依赖审计为10项（3项低危、3项中危、4项高危、0项严重），文档站为0项。

## 后续合并规则

- 新改动追加到CHANGELOG的“未发布”章节，并在本文件记录专项测试和已知边界。
- 发布时main仅使用`--ff-only`接收dev，整理正式版本和文档后删除本文件。
- 发布完成后dev快进main，再重建精简基线说明；不挑选、压缩或改写已经验证的功能提交。
