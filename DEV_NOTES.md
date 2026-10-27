# 开发与验证说明

功能变化、修复和升级注意事项统一记录在 [更新日志](CHANGELOG.md)；开发版请查看其中的 `Unreleased`。

## 验证范围

- 类型与架构检查：检查服务端、浏览器和测试代码的类型，以及模块依赖和资源所有权。
- 单元与集成测试：覆盖任务调度、下载恢复、上传确认、共享归档保护及持久化事务。
- 界面回归：覆盖桌面、手机与横屏的导航、设置、归档管理、播放和请求状态。
- 构建检查：验证应用和文档能够正常生成；镜像相关改动还需通过对应的镜像验收。

测试使用隔离数据。环境或设备条件不满足的项目应明确标为跳过，不能计入通过；模拟结果不代表所有真实存储后端或实体设备均已验证。

## 本地检查

按改动范围选择检查；完整验收入口如下：

```sh
npm run typecheck:server
npm run typecheck:web
npm run typecheck:tests
npm run check:architecture
npm test
npm run build
npm --prefix docs run docs:build
npm run test:ui
git diff --check
```

发布构建的结果以对应提交的 [GitHub Actions](https://github.com/minori0721/Bili-favorites-backup/actions) 为准。

### CI 构建与测试复用

应用只在 Dockerfile 的 `builder` 阶段执行完整发布构建，其中保留类型、架构、编译和资源检查；不再在 GitHub 宿主机额外生成不会交付给 Docker 的 `dist`。测试所需网页资源仍由 `npm test` 的 `pretest` 准备。

main 的 push 只查成功的 dev push；正式 `vX.Y.Z` 标签的 push 依次查 main、dev。必须是同一仓库、同一工作流路径、同一完整提交和工作流 SHA，且对应 run attempt 中的 `Test application` 实际成功执行，才复用测试并跳过测试媒体工具准备。main 本身复用过 dev 测试时，其跳过的测试步骤不能充当标签发布的证据，需继续查原始 dev 记录。

dev、非正式标签和所有手动运行（包括“仅重建镜像”）不复用测试。证据缺失、不完整或 API 失败时运行全量测试；镜像构建、启动、安全与层检查继续执行。复用记录写入本次 Actions 摘要，保留对应 run 链接。

### CI 媒体工具安装

Ubuntu 24.04 测试机缺少 FFmpeg 或 ffprobe 时，使用临时 Ubuntu 源配置，先从官方主源下载，失败后仅切换一次 Kernel.org 镜像。每个源的索引与软件包下载共限时 180 秒，保留 Ubuntu 签名校验，并跳过额外推荐包；全部下载成功后再离线安装，安装失败直接终止，不通过中断 dpkg 换源。

此配置仅用于 CI 测试机，不修改 Docker 镜像内工具或服务器软件源。`tests/ci-media-tools.test.ts` 在 Linux 隔离模拟外部命令，验证实际工作流脚本的超时、回退、安装失败和已有工具路径；真实下载速度仍以 Actions 运行结果为准。

### 运行镜像安全更新

Dockerfile 的 `runtime-tools` 阶段显式安装或更新 `libssl3` 和 `openssl`，并移除最终运行环境中的 npm/npx 及 npm 自带依赖；依赖安装、裁剪和应用构建阶段继续使用 npm。普通应用构建保留缓存，手动“仅重建镜像”同时拉取新基础镜像并通过 `no-cache-filters` 重新执行 `runtime-tools`，其他独立阶段仍可复用缓存。

CI 在候选容器中执行 `scripts/check-image-runtime.sh`，检查 Node、aria2、FFmpeg、ffprobe 和 BBDown 可执行，npm/npx 及其目录不存在，两个 OpenSSL 系统包均达到该脚本声明的 Debian 修复版本下限；运行媒体工具的版本或帮助命令，核实程序能启动，同时记录 Node 内置的 Undici 和 OpenSSL 版本。该检查位于标签推广之前，不添加启动时检查或修改应用版本。

本地隔离测试验证验收脚本的通过与拒绝路径，不代表已经生成修复镜像。真实 Linux 包安装、下载上传行为、候选镜像验收和扫描结果以对应 Actions 与新镜像为准。

完整镜像扫描与现有告警处置见 [镜像安全核验](docs/development/image-security.md)。候选镜像在标签推广前保存运行组件清单和未过滤的 Scout SARIF 报告，再单独拒绝已有修复版本的严重/高危告警；扫描失败不会继续推广标签。`docker-compose.security.yml` 提供可选的最小权限覆盖配置，不改变既有数据的所有者。

## 相关文档

- [开发与架构指南](docs/development/architecture.md)
- [归档管理验证路径](docs/development/archive-actions-verification.md)
- [UP 订阅实现说明](docs/development/up-subscriptions.md)
