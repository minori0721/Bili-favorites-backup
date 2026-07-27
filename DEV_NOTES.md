# Dev 测试说明

## 当前基线

- 基准版本：`v2.4.4`，应用版本号保持不变。
- main发布提交：`92db996a125638cfb0e6e85352e097a0a316233d`。
- SQLite：`user_version 6`；升级前继续生成一致性备份及SHA256摘要。
- JSON兼容状态：schema 13；迁移包：schema 3。
- 本轮仅本地开发，尚未提交、推送或更新服务器。

## 本轮语义

- 下架清单由SQLite按`missing/uploaded`服务端筛选，使用`last_seen_at + bvid + media_id`键集游标；前端两个标签各自缓存节点和游标，翻页不重建旧卡片。
- `unavailable_cover_backfill_v2`只记录一次性封面回填数量摘要；v2会重试曾因旧HTTP封面地址失败的v1数据，完整状态或封面导入会删除当前标记并重新异步检查。
- `qualityProfile`继续表示请求目标；`remote_files.actual_*`和`mediaMetadata`才表示已确认的实际媒体参数。旧记录的`dfn`不会回填为真实画质。
- 浏览器媒体上报只接受宽高和时长，使用当前fileId、大小、路径及更新时间组成的fingerprint；ffprobe结果优先且原位更新不改变fileId。
- 播放传输attempt状态只在内存保留5分钟；AList入口只返回受保护的302，不进入播放队列JSON。
- 旧目录清理新增持久状态`cleanup_running`；“保留/删除”通过SQLite条件更新原子领取，重启只回到`cleanup_pending`等待人工复核，不自动继续删除。
- 播放代理不再使用自动重定向；最多手动验证5跳，跨源后永久移除AList认证并拒绝HTTP、私网DNS、异常端口和循环地址。
- Windows `taskkill`每次最多等待3秒；封面ffmpeg最多15秒，封面回填或队列未能在30秒内停止时禁止迁移导入、状态清理和封面删除。
- 下架清单先使用`idx_relations_user_unavailable_page`与`idx_relations_user_unavailable_latest`选择当前页键，再批量加载最多50条JSON；50000条关系的真实SQL计划不再包含窗口排名或临时排序。
- 浏览器媒体元数据按BVID、远端路径和文件大小同步到等价已验证记录；不同文件隔离，任何ffprobe记录均不被浏览器结果覆盖。

## 验证命令

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

本轮完整逻辑套件共222项：221项通过，1项因本机未安装aria2跳过，0项失败。首次完整回归的全部业务断言完成后，Windows删除烟雾测试隔离目录时出现一次`EBUSY`；单项复跑及第二轮完整回归均通过，遗留测试目录已删除。浏览器插件按用户明确要求完全不调用，1280×720、390×844和844×390视觉验收记为未执行，不计为代码测试通过。

阿里云现场只读验证的908条失效视频封面在升级为HTTPS后全部返回`200 image/jpeg`；29个分层样本均可完整下载并由ffprobe解码，12个HTTP/HTTPS对照样本的SHA256完全一致，7个无Cookie/Referer样本均可按BFB参数转换为WebP。验证未写入SQLite、AList或封面目录。

## 后续合并规则

- 新开发内容先进入dev，并记录在CHANGELOG的“未发布”章节和本文件中。
- 发布时main只使用`git merge --ff-only`同步dev，不挑选、压缩或改写提交。
- main发布提交删除本文件；版本标签和main工作流成功后，dev再快进main并重建精简说明。
