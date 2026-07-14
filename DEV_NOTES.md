# Dev 测试说明

本文只记录`dev`相对`main`的未发布变化。稳定内容发布到main时应整理进README和CHANGELOG，并重新建立本文件。

## 当前状态

- 分支：`dev`
- 基准版本：`2.4.1`
- 当前dev变更：新增独立VitePress演示文档站、脱敏WebUI截图和GitHub Pages工作流；根README收敛为项目入口，应用逻辑与版本号未修改。
- 镜像：推送dev后发布`minori0721/bili-favorites-backup:dev`；`latest`仍只由main发布。

## GitHub Pages文档站

- `docs/`固定使用Node.js 24与`vitepress@1.6.4`，版本导航自动读取根`package.json`。
- 站点使用`/Bili-favorites-backup/`子路径、本地搜索、中文导航、编辑链接、sitemap、浅色/深色主题和自定义404。
- 34个Markdown页面覆盖快速开始、AList、功能演示、日常维护、问题排查和用户视角参考，不公开内部API百科。
- 7张静态PNG全部由`tests/browser-preview.ts`合成夹具生成，包含1280px桌面、390px移动端、上传确认、AList异常、B站风控、充电视频和共享画质下载；未连接真实服务器。
- `dev`只构建并上传Pages产物，`main`才部署公开站点；纯文档提交不会触发Docker镜像工作流。

## 基线验证

- `npm ci`：通过。
- `npm test`：156项，155通过、0失败、1跳过；跳过项仅因本机未安装`aria2c`，GitHub Actions已执行完整媒体工具与构建路径。
- `npm run build`与`git diff --check`：通过。
- `npm audit --omit=dev`：保留`@renmu/bili-api -> fast-xml-parser`的2个中危，不执行破坏性`audit fix --force`。
- `npm --prefix docs ci`与`npm --prefix docs run docs:build`：通过，内部链接、静态资源与sitemap均成功生成；`npm --prefix docs audit --omit=dev`为0。
- 固定VitePress的开发构建链完整审计仍报告Vite/esbuild的2个中危与1个高危，当前无兼容修复版本；Pages只发布静态产物，本地预览仅绑定`127.0.0.1`。
- 文档站已检查1280px与390px首页、移动菜单、搜索、深色模式、上下页、编辑链接、404和多个深层URL；无整页横向溢出，正常页面控制台无错误。
- 1280px桌面与390px移动端已验证`v2.4.1 · main@25496bc`版本入口、GitHub链接和头部换行，无整页横向溢出或控制台错误。
- 当前服务器运行的AList为`v3.60.0`；Compose默认`v3.61.0`的真实网盘驱动兼容性仍需单独验证。

## 后续合并规则

1. 新开发只在本文件记录相对main的行为、测试与已知边界。
2. 合并main前先确认main仍是dev祖先，并使用`--ff-only`同步。
3. 正式发布时删除main中的本文件，把用户可见内容整理进README和CHANGELOG。
