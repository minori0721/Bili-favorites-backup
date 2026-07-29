# Dev 测试说明

## 当前基线

- 基准版本：`v2.4.5`。
- main发布提交：`ab9f59fbae30e4ac20fc5bb8aa03e66bb7affc99`。
- SQLite：`user_version 6`；JSON兼容状态：schema 13；迁移包：schema 3。
- dev当前有未提交的APP下载配套改动：为每个账号持久化独立`appBuvid`，并通过BBDown私有临时配置传递，不进入WEB Cookie。
- 配套的本地`BBDown-src`工作区已将普通UGC迁移到PlayerUnite，合并AVC、HEVC和AV1结果；APP结果仅480P或低于明确请求档位时只择优合并更高的WEB视频，保留APP音频。PGC接口不变。
- BBDown fork已发布`bfb-2.0.1`，Release和标签指向`fd926373dfe03d68bf84a1ad8a4ffbf402b00988`；Docker已固定该Release、源码提交及ZIP SHA256 `341eef88483d0cd4461031beee5c8de54192f1427e698970e33b81c3ed933074`。
- BBDown提交升级时只复用配置未变化的WEB未完成轨道；APP未完成轨道会隔离后重新下载，避免旧480P半成品绕过PlayerUnite修复。已验证输出继续保留。

## 发布验证

```bash
npm ci
npm test
npm run build
npm --prefix docs ci
npm --prefix docs run docs:build
git diff --check
npm audit --omit=dev
npm --prefix docs audit --omit=dev
```

- BFB完整逻辑套件共246项：245项通过，1项因本机未安装aria2跳过，0项失败。
- BBDown .NET 9测试共14项，覆盖PlayerUnite请求、三编码合并、局部失败、空流信号、真实媒体字段、稳定buvid、请求日志脱敏和WEB视频择优，全部通过；NuGet直接及传递依赖漏洞检查为0项。
- BBDown GitHub Actions已完成Linux x64 NativeAOT构建、版本与无DLL校验并上传Release；Release工作流和14项.NET测试均通过。本机没有Docker，因此BFB镜像构建仍需由后续GitHub Actions验证。
- 根生产依赖审计为10项（3项低危、3项中危、4项高危、0项严重），文档站生产依赖审计为0项。
- main的`latest`镜像、GitHub Pages和`v2.4.5`版本镜像工作流均已成功。

## 后续合并规则

- 新开发内容先进入dev，并记录在CHANGELOG的“未发布”章节和本文件中。
- 发布时main只使用`git merge --ff-only`同步dev，不挑选、压缩或改写提交。
- main发布提交删除本文件；版本标签和main工作流成功后，dev再快进main并重建精简说明。
