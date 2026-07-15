# Dev 测试说明

本文只记录`dev`相对`main`的未发布变化。稳定内容发布到main时应整理进README、CHANGELOG或文档站，并重新建立本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.4.1`
- 当前dev变更：Photo风格演示站与统一应用图标；队列文件统计改为10秒异步快照；SQLite升级到`user_version 4`并索引充电限制与远端核验调度。
- 文档站：<https://minori0721.github.io/Bili-favorites-backup/>

## 基线验证

```bash
npm ci
npm test
npm run build
npm audit --omit=dev
npm --prefix docs ci
npm --prefix docs run docs:build
```

- 应用测试：161项，160通过、0失败、1项仅因本机缺少`aria2c`跳过。
- schema 1–3升级前会在`data/backups`生成schema 4一致性备份和SHA256；旧镜像回滚必须恢复该备份或使用JSON导出。
- 根依赖审计保留`fast-xml-parser`的2个中危，不执行破坏性`audit fix --force`。
- 文档生产依赖审计为0；固定VitePress开发构建链的Vite/esbuild告警只影响本地开发服务器，Pages发布静态产物。

## 后续合并规则

1. 新开发只在本文件记录相对main的行为、测试与已知边界。
2. 合并main前确认main仍是dev祖先，并使用`--ff-only`同步。
3. 正式发布时删除main中的本文件，把用户可见内容整理进README、CHANGELOG或文档站。
