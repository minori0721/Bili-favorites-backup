# Dev 测试说明

本文只记录`dev`相对`main`的未发布变化。稳定内容发布到main时应整理进README、CHANGELOG或文档站，并重新建立本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.4.3`
- 当前dev变更：暂无，应用代码与main一致。
- SQLite：`user_version 5`
- JSON兼容状态：schema 13
- 迁移包：schema 3
- 文档站：<https://minori0721.github.io/Bili-favorites-backup/>

## 基线验证

```bash
npm ci
npm test
npm run build
npm audit --omit=dev
npm --prefix docs ci
npm --prefix docs run docs:build
npm --prefix docs audit --omit=dev
git diff --check
```

- `v2.4.3`发布基线：184项中183项通过、1项因本机缺少aria2跳过、0项失败。
- TypeScript生产构建和VitePress文档构建通过。
- 根生产依赖审计保留15项上游风险；文档站生产依赖审计为0，不执行破坏性`npm audit fix --force`。

## 后续合并规则

1. 新开发只在本文件记录相对main的行为、测试与已知边界。
2. 合并main前确认main仍是dev祖先，并使用`--ff-only`同步。
3. 正式发布时删除main中的本文件，把用户可见内容整理进README、CHANGELOG或文档站。
