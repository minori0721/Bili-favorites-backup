# Dev 测试说明

## 当前基线

- 基准版本：`v2.4.4`
- main发布提交：`92db996a125638cfb0e6e85352e097a0a316233d`
- 当前dev除本说明文件外没有额外代码或文档变化。
- SQLite：`user_version 5`
- JSON兼容状态：schema 13
- 迁移包：schema 3

## 验证命令

```bash
npm ci
npm test
npm run build
npm --prefix docs ci
npm --prefix docs run docs:build
git diff --check
npm audit --omit=dev
npm --prefix docs audit --omit=dev
```

`v2.4.4`本地基线为202项测试中201项通过、1项因缺少aria2跳过、0项失败；GitHub Actions环境全部通过。根生产依赖审计为10项（3项低危、3项中危、4项高危、0项严重），文档站生产依赖审计为0。

## 后续合并规则

- 新开发内容先进入dev，并记录在CHANGELOG的“未发布”章节和本文件中。
- 发布时main只使用`git merge --ff-only`同步dev，不挑选、压缩或改写提交。
- main发布提交删除本文件；版本标签和main工作流成功后，dev再快进main并重建精简说明。
- 未经单独发布计划，不修改SQLite、JSON兼容状态或迁移包schema。
