# Dev 测试说明

## 当前基线

- 基准版本：`v2.4.5`。
- main发布提交：`ab9f59fbae30e4ac20fc5bb8aa03e66bb7affc99`。
- SQLite：`user_version 6`；JSON兼容状态：schema 13；迁移包：schema 3。
- dev当前除本文件外与main发布内容一致，没有额外功能代码变化。
- APP接口在部分账号或视频上可能静默取得480P流并被BBDown视为成功；关闭Hi-Res和杜比时暂建议使用WEB接口，结果识别与安全自动回退留待后续版本处理。

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

- 完整逻辑套件共242项：241项通过，1项因本机未安装aria2跳过，0项失败；GitHub Actions环境中的媒体工具检查、测试和构建全部通过。
- 根生产依赖审计为10项（3项低危、3项中危、4项高危、0项严重），文档站生产依赖审计为0项。
- main的`latest`镜像、GitHub Pages和`v2.4.5`版本镜像工作流均已成功。

## 后续合并规则

- 新开发内容先进入dev，并记录在CHANGELOG的“未发布”章节和本文件中。
- 发布时main只使用`git merge --ff-only`同步dev，不挑选、压缩或改写提交。
- main发布提交删除本文件；版本标签和main工作流成功后，dev再快进main并重建精简说明。
