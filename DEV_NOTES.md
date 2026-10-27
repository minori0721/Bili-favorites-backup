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

## 相关文档

- [开发与架构指南](docs/development/architecture.md)
- [归档管理验证路径](docs/development/archive-actions-verification.md)
- [UP 订阅实现说明](docs/development/up-subscriptions.md)
