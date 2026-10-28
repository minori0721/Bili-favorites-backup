# 开发与验证入口

功能变化、修复和升级注意事项统一记录在 [更新日志](CHANGELOG.md)；开发版请查看其中的 `Unreleased`。

## 检查入口

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

测试使用隔离数据，跳过项不计为通过。发布构建以对应提交及固定镜像摘要的 [GitHub Actions](https://github.com/minori0721/Bili-favorites-backup/actions) 结果为准；源码或假服务测试不能代替真实下载、上传与设备验证。

## 相关文档

- [开发与架构指南：测试范围、CI 与版本规则](docs/development/architecture.md)
- [镜像安全核验与已知限制](docs/development/image-security.md)
- [运行环境重建与部署更新](docs/operations/update.md)
- [归档管理验证路径](docs/development/archive-actions-verification.md)
- [UP 订阅实现说明](docs/development/up-subscriptions.md)
