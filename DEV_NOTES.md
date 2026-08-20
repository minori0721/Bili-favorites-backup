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

- `npm test`：361 项，359 项通过；1 项因本机缺少 `aria2c` 跳过，1 项因 Windows 环境不允许创建软链接或 junction 跳过，0 项失败。
- `npm run test:ui`：42 项，24 项通过，18 项按环境条件跳过，0 项失败。
- 根项目和文档站构建通过，`git diff --check` 通过。
- 根项目生产依赖审计：11 项（2 低危、3 中危、6 高危、0 严重）；文档站：0 项。
- Docker Publish 和 Docs Pages 已由 `main` 与 `v2.5.0` 标签工作流验证成功。

## 后续规则

- 新改动追加到 CHANGELOG 的“未发布”章节，并在本文件补充专项测试和已知边界。
- 发布时 `main` 仅使用 `--ff-only` 接收 `dev`，不挑选、压缩或改写已验证提交。
- 发布完成后将 `dev` 快进到发布提交，再重建本文件；正式发布说明不保留本文件。
- 本次未更新 Aliyun 服务器；`output/` 为本地未跟踪测试产物，不属于发布内容。

## 本轮未发布修复

- 来源级删除的维护状态现在始终携带 `userId/mediaId/bvid`。删除工作线程进入 `running` 后仍能准确阻止目标来源，其他账号和其他视频不被全局暂停。
- 共享下载、共享画质下载和后续质量上传会按来源裁剪；被删除来源没有剩余目标时不再生成上传/验证任务。重启恢复同样过滤已被删除的来源，禁止删除期间自动重新上传。
- 远端目录仍不发送集合 `DELETE`；这里只补强调度隔离和恢复一致性，不改变已验证文件、历史关系、AList/OpenList路径迁移或公开API。

### 本轮专项验证

- 来源删除运行阶段身份传递：通过。
- 多目标来源锁、共享下载/质量任务裁剪、质量恢复过滤和禁止重新上传：通过。
- 当前新增专项合计：`65 passed`，无失败、无挂起；完整测试、UI 测试、文档构建和最终审计均已完成。
- Codex应用内浏览器只连接本地隔离假服务，检查桌面 `1280×720`、手机竖屏 `390×844` 和横屏 `844×390`；不连接真实B站、AList/OpenList或服务器。
- 应用内浏览器三个视口均无横向溢出；归档库目录/网格切换、详情关闭后的焦点恢复、Escape 关闭顶层确认框和来源删除确认框层级均通过；页面控制台无 warning/error。

### 当前未发布的自动恢复收口

- “完整旧档 + 新候选”保持 `intentional_confirmation`，只提供“保留现有归档 / 采用新候选”，不会自动覆盖正式旧路径、删除旧文件或混合新旧分P。
- 远端暂时不可见、网络抖动和可重试上传错误标记为后台复核；权限、不支持的方法、未知冲突和无法安全分类的错误进入人工问题中心。
- 本地补传文件自动重新下载上限为3次；达到上限后保留原上传恢复任务和脱敏诊断，不生成自动循环。
- B站授权刷新失败按 `transient/permanent/unknown` 分类：临时错误按1小时、6小时、24小时退避，401/403或refreshToken失效停止自动刷新；未知错误最多尝试3次。
- 新增 `src/auth-refresh.ts` 的分类、退避和失败状态专项测试；完整测试结果待本轮最终命令完成后补录。

### 本轮最终验证（2026-08-20）

- `npm ci`：通过；根项目安装后审计提示现有生产依赖11项（2低、3中、6高、0严重），未执行破坏性自动修复。
- `npm test`：367项，365通过，2项按环境跳过（缺少 `aria2c`、Windows 不允许创建软链接或 junction），0失败、0挂起。
- `npm run test:ui`：45项，27通过，18按环境条件跳过，0失败；覆盖桌面 `1280x720`、手机竖屏 `390x844` 和横屏 `844x390`。
- `npm run build`、`npm --prefix docs ci`、`npm --prefix docs run docs:build` 和 `git diff --check`：通过。
- 文档站生产依赖审计：0项；根项目审计告警均为现有上游传递依赖，本轮没有降低安全边界或强制降级。
