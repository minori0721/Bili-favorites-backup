# Dev 测试说明

本文只记录`dev`相对`main`的未发布变化。稳定内容发布到main时应整理进README、CHANGELOG或文档站，并重新建立本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.4.3`
- 当前dev变更：收藏夹“查看详情”统一数据源并修复已上传后失效视频的标题、封面与状态展示；Archiver升级到8.0.0。
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
- `v2.4.3`发布时根生产依赖审计保留15项上游风险；当前dev升级Archiver后降至10项。文档站生产依赖审计为0，不执行破坏性`npm audit fix --force`。

## 未发布详情修复

- 已同步收藏夹的全部筛选均从SQLite分页读取，不因打开详情或滚动列表请求B站；未同步收藏夹仅“全部”保留实时浏览，并使用SQLite补全已知BVID。
- `/api/users/:id/favorites/:mediaId/detail-items`为统一入口，`state-items`保留为同一服务的兼容别名；响应增加`source`、`tracked`、`lastSyncedAt`和`coverage`。
- 详情汇总增加当前/历史关系数量，索引覆盖率只使用当前活动关系；历史关系排在当前收藏顺序之后，并显示“历史记录”次级徽章。
- 远程与本地封面按视频有效性采用不同回退顺序；分页失败保留已有卡片并可重试，筛选切换和关闭弹窗通过`AbortController`隔离过期响应。
- SQLite `user_version 5`、JSON schema 13、迁移包schema 3及应用版本`2.4.3`均保持不变。

## 未发布依赖维护

- `archiver`与`@types/archiver`同步升级到8.0.0，ZIP构造改用原生ESM导出的`ZipArchive`；ZIP64、压缩级别、文件清单和流式输出行为保持不变。
- Archiver依赖链已使用`readdir-glob 3`、`minimatch 10`和`brace-expansion 5`，不再携带旧`archiver-utils/glob`链；`npm audit --omit=dev`从15项降至10项（3项低危、3项中危、4项高危）。
- 迁移、ZIP和真实应用专项24项全部通过；更新锁文件后`npm ci`成功，完整回归仍为187项中186项通过、1项因本机缺少aria2跳过、0项失败，TypeScript生产构建通过。

### 本地验收

- 新增详情元数据回退、SQLite来源、兼容别名、活动/历史排序及计数测试。
- 1280x720与390x844浏览器检查无横向溢出，关闭按钮可见，远程封面失败后6张卡片均加载本地封面，控制台无错误。
- 模拟后续页失败时已加载6项保持不变且重试成功；模拟慢请求后快速切换筛选只保留新筛选结果。
- 干净全量回归为187项中186项通过、1项因本机缺少aria2跳过、0项失败；Windows曾在结束后清理隔离目录时偶发`EBUSY`，受影响的真实应用测试单独复跑为1项通过、0项失败。

## 后续合并规则

1. 新开发只在本文件记录相对main的行为、测试与已知边界。
2. 合并main前确认main仍是dev祖先，并使用`--ff-only`同步。
3. 正式发布时删除main中的本文件，把用户可见内容整理进README、CHANGELOG或文档站。
