# Dev 测试说明

## 当前基线

- 基准版本：`v2.4.6`，发布提交：`2da980b`。
- 当前dev在发布基线上增加归档库分页、投影、恢复和前端竞态收口，尚未提交或推送。
- SQLite：`user_version 8`；JSON兼容状态：schema 13；迁移包：schema 3。
- BBDown固定为fork Release `bfb-2.0.1`，源码提交`fd926373dfe03d68bf84a1ad8a4ffbf402b00988`。

## 当前dev改动

- schema 8新增全局和账号范围的`archive_library_projection`持久投影。schema 7升级前生成一致性备份与SHA256，在同一事务中完成建表、索引和全量投影；写入后按脏BVID增量刷新。收藏夹范围继续实时读取关系顺序。
- 历史收藏夹游标显式保存顺序是否已知，不再把缺失顺序映射为超大JavaScript整数；不安全旧游标返回`ARCHIVE_CURSOR_STALE`并由前端自动重置一次。
- 归档列表当前页的来源、删除状态和远端统计改为批量CTE水合；播放器焦点定位移除全量窗口排名，相邻页使用双向键集游标，旧数字页保持兼容。
- 当前登录的同UID账号会在启动和数据库重载后恢复遗留归档快照、脱离关系及暂停任务，但未完成或失败待处理的账号删除会继续阻止恢复。
- 归档目录、列表、账号删除进度和来源删除启动响应按会话、账号、操作及详情代次隔离，迟到响应不能覆盖新打开的弹窗或详情。
- 1万个唯一BV、5万条关系的压力夹具完成全量分页且无重复遗漏；schema 8一次性投影构建本机约21秒，归档库综合压力测试约25秒。测试未连接真实B站、AList或服务器。

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

- 当前dev本地逻辑测试共283项：282项通过，1项仅因本机缺少aria2跳过；Playwright三个视口共11项适用场景通过，16项按项目视口条件跳过。
- 应用与文档构建通过。根生产依赖审计为10项（3项低危、3项中危、4项高危、0项严重），文档站为0项。
- schema 8回滚必须恢复`data/backups`中的schema 7升级前备份；schema 7及更早镜像不能直接打开schema 8数据库。

## 后续合并规则

- 新改动追加到CHANGELOG的“未发布”章节，并在本文件记录专项测试和已知边界。
- 发布时main仅使用`--ff-only`接收dev，整理正式版本和文档后删除本文件。
- 发布完成后dev快进main，再重建精简基线说明；不挑选、压缩或改写已经验证的功能提交。
