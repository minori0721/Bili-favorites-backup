---
layout: home

hero:
  name: Bili-favorites-backup
  text: 面向AList云盘的B站收藏夹持续备份系统
  tagline: 持续监控收藏夹，可靠下载、上传，并确认远端文件真正存在
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/introduction
    - theme: alt
      text: Docker部署
      link: /guide/docker

features:
  - icon: ☁️
    title: 云盘持续归档
    details: 使用BBDown下载收藏内容，并通过AList WebDAV持续写入目标网盘。
  - icon: ♻️
    title: 中断自动恢复
    details: SQLite持久任务、aria2断点和下载会话共同支持容器重启恢复。
  - icon: ✅
    title: 远端最终确认
    details: 远端文件可见且大小一致后，才确认备份完成并安全清理本地成品。
---

## 项目简介

Bili-favorites-backup（BFB）是一个面向云盘归档的B站收藏夹持续备份系统，重点解决以下问题：

- 持续发现多个账号、多个收藏夹中的新增与状态变化。
- 使用固定版本BBDown与aria2完成下载、分P识别和中断恢复。
- 通过AList WebDAV上传，并在远端文件真正可见后确认备份完成。

## 适合什么场景

- 已经使用AList管理阿里云盘、夸克、百度网盘或115等存储。
- 希望收藏夹内容长期自动留档，并保留旧分P与下架内容的备份证明。
- 需要多账号、多收藏夹和多个远端目标分别确认上传状态。
- 希望Docker重启后继续下载、补传和远端确认，而不是重新开始。

## 明确边界

- BFB不是Emby、Jellyfin或Infuse媒体库，不负责刮削与在线播放。
- BFB不会绕过付费、充电、地区或账号权限，试看也不算完整备份。
- 本地`data`与`temp`必须持久化，迁移包和账号文件需要按敏感数据保管。

## 推荐阅读路径

1. 第一次使用：[项目定位](/guide/introduction)与[5分钟Docker部署](/guide/docker)
2. 准备上传：[连接AList](/alist/overview)
3. 了解任务行为：[整体运行流程](/features/workflow)
4. 日常维护：[更新镜像](/operations/update)与[迁移、备份和回滚](/operations/migration)
5. 遇到异常：[问题排查](/troubleshooting/docker-hub)

## 版本说明

- 当前文档维护`main`稳定版的用户可见行为。
- 导航中的版本号自动读取仓库根目录`package.json`。
- 版本变更与兼容性说明见[版本与升级记录](/reference/releases)。
