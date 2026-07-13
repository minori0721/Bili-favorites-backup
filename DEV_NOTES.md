# Dev 测试说明

本文只记录`dev`相对`main`的未发布变化。稳定内容发布到main时应整理进README和CHANGELOG，并重新建立本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.4.1`
- 当前dev变更：暂无；除本文件外，代码与main发布提交`25496bc`一致。
- 镜像：推送dev后发布`minori0721/bili-favorites-backup:dev`；`latest`仍只由main发布。

## 基线验证

- `npm ci`：通过。
- `npm test`：156项，155通过、0失败、1跳过；跳过项仅因本机未安装`aria2c`，GitHub Actions已执行完整媒体工具与构建路径。
- `npm run build`与`git diff --check`：通过。
- `npm audit --omit=dev`：保留`@renmu/bili-api -> fast-xml-parser`的2个中危，不执行破坏性`audit fix --force`。
- 1280px桌面与390px移动端已验证`v2.4.1 · main@25496bc`版本入口、GitHub链接和头部换行，无整页横向溢出或控制台错误。
- 当前服务器运行的AList为`v3.60.0`；Compose默认`v3.61.0`的真实网盘驱动兼容性仍需单独验证。

## 后续合并规则

1. 新开发只在本文件记录相对main的行为、测试与已知边界。
2. 合并main前先确认main仍是dev祖先，并使用`--ff-only`同步。
3. 正式发布时删除main中的本文件，把用户可见内容整理进README和CHANGELOG。
