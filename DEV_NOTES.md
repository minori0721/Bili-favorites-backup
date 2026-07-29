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
- `qualityProfile`继续保存下载请求配置，但播放器不展示它。新下载从BBDown的`[视频]`选择行取得真实B站档位，按CID写入下载清单`selectedStreams`，上传时保存为`filenameMetadata.bilibiliQuality`；旧清单没有该字段时省略B站档位，不按尺寸猜测。
- 普通上传和画质升级共用`buildUploadFileMetadataFromSession()`从持久下载清单重建CID、分P、B站档位和ffprobe实际媒体参数；画质升级任务重启或向多个收藏夹分发时不依赖内存中的元数据映射。
- 画质升级在创建远端暂存目录前要求所有输出与清单一一匹配，并具备有效的ffprobe宽高和验证时间。预检失败时不执行上传或MOVE，旧远端文件、本地成品和下载清单保持不变；旧清单仅缺少B站档位时仍可继续。
- APP接口在部分账号或视频上可能静默取得480P流且被BBDown视为成功；本轮不修改APP模式，关闭Hi-Res和杜比时暂建议使用WEB接口，结果识别与自动回退留待下一版本处理。
- BBDown 2.0.0真实选择行是`[视频][画质][编码][码率][预估大小]`；解析器要求去除时间戳后的正文以`[视频]`开头，按字段内容识别可选编码、码率、大小和旧式分辨率。下载器持久化类型只包含分P序号与规范化B站档位，其余字段仅用于日志诊断。
- `remote_files.actual_*`和`mediaMetadata`表示ffprobe或浏览器确认的实际媒体参数。播放信息固定按“P序号 · B站档位 · 实际画质 · 精确尺寸与方向 · 实际编码 · 传输方式”排列，例如`P1 · B站4K · 实际1772p · 1772×3840 竖屏 · HEVC · 网盘直连`。
- 浏览器媒体上报只接受宽高和时长，使用当前fileId、大小、路径及更新时间组成的fingerprint；ffprobe结果优先且原位更新不改变fileId。
- 播放传输attempt状态只在内存保留5分钟；AList入口只返回受保护的302，不进入播放队列JSON。
- 旧目录清理新增持久状态`cleanup_running`；“保留/删除”通过SQLite条件更新原子领取，重启只回到`cleanup_pending`等待人工复核，不自动继续删除。
- 播放代理不再使用自动重定向；最多手动验证5跳，跨源后永久移除AList认证并拒绝HTTP、私网DNS、异常端口和循环地址。
- Windows `taskkill`每次最多等待3秒；封面ffmpeg最多15秒，封面回填或队列未能在30秒内停止时禁止迁移导入、状态清理和封面删除。
- 下架清单先使用`idx_relations_user_unavailable_page`与`idx_relations_user_unavailable_latest`选择当前页键，再批量加载最多50条JSON；50000条关系的真实SQL计划不再包含窗口排名或临时排序。
- 浏览器媒体元数据按BVID、远端路径和文件大小同步到等价已验证记录；不同文件隔离，任何ffprobe记录均不被浏览器结果覆盖。
- `actualQualityLabel()`不再把非标准短边向下归档；真实短边直接形成画质标签，`1772×3840`为`1772p`，不低于50fps时为`1772p60`。播放器同时显示精确尺寸和横屏、竖屏或方形方向。
- 播放错误策略读取`HTMLMediaElement.error.code`：网络错误最多从直连回退代理一次，解码错误不回退；实际编码优先，旧记录缺少实际编码时仅在内部使用下载编码偏好做保守兼容判断，该偏好不显示为实际编码。
- 播放delivery视图只把`direct/proxy`视为已确认传输方式；后端`failed`和状态查询异常均显示未知。同一attempt已确认直连后，失败状态不能覆盖它，真正进入代理后才升级为`proxy`。
- “归档库”入口位于“全量扫描并对账”之后。`/api/archive-library/navigation|items|items/:bvid|playback-queue|playback-search`全部受管理员Session保护，只读取SQLite和`users.json`，不调用B站或AList列表接口，也不返回远端路径、Cookie、AList凭据或临时签名URL。
- 聚合范围按BVID去重，收藏夹范围按当前关系、`favOrder`和历史`lastSeenAt`稳定排序；键集游标包含查询上下文摘要。播放器`library`模式保留基础目录查询，侧栏搜索通过`queueQ`继续AND过滤，并使用队列项`source`调用原有文件鉴权接口。
- 同一BV的最佳来源只比较已验证可播放成品：全分P实际尺寸、实际帧率、完整备份、已验证分P数和确认时间依次降序；全部实际参数未知时不会根据下载目标冒充高画质。手动重试会重新查询当前库队列，允许切换到仍有效的其他来源。
- 10000个唯一视频、50000条收藏关系的专项用例完整遍历200个键集页面，无重复或遗漏；`EXPLAIN QUERY PLAN`分别命中`idx_relations_library_recent`和`idx_relations_library_folder`。独立Playwright CLI使用系统Edge检查1280×720、390×844和844×390，未调用Codex浏览器插件。

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

本轮完整逻辑套件共242项：241项通过，1项因本机未安装aria2跳过，0项失败。新增用例覆盖共享元数据重建、旧清单缺少B站档位、严格预检、重启及多收藏夹复用、画质升级关系JSON和`remote_files.actual_*`写回；预检失败不会调用上传或MOVE。此前独立Playwright CLI使用系统Edge完成1280×720、390×844和844×390检查：无横向溢出或控制台错误，无限滚动由50项追加到100项，深页SQLite搜索和`归档库顺序`播放器均验证成功；全程未调用Codex浏览器插件。本轮未改前端，因此未重复浏览器检查。根生产依赖审计为10项（3项低危、3项中危、4项高危、0项严重），文档站为0项。

阿里云现场只读验证的908条失效视频封面在升级为HTTPS后全部返回`200 image/jpeg`；29个分层样本均可完整下载并由ffprobe解码，12个HTTP/HTTPS对照样本的SHA256完全一致，7个无Cookie/Referer样本均可按BFB参数转换为WebP。验证未写入SQLite、AList或封面目录。

## 后续合并规则

- 新开发内容先进入dev，并记录在CHANGELOG的“未发布”章节和本文件中。
- 发布时main只使用`git merge --ff-only`同步dev，不挑选、压缩或改写提交。
- main发布提交删除本文件；版本标签和main工作流成功后，dev再快进main并重建精简说明。
