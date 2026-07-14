---
layout: doc
pageClass: home-doc
title: Bili-favorites-backup
description: 把B站收藏夹持续归档到AList云盘，并确认远端文件真的存在
sidebar: false
aside: false
outline: false
editLink: false
lastUpdated: false
---

<div class="home-intro">
  <h1>Bili-favorites-backup</h1>
  <p class="value">把B站收藏夹持续归档到AList云盘，并确认远端文件真的存在</p>
  <div class="home-actions">
    <a class="home-action primary" href="./guide/docker">5分钟部署</a>
    <a class="home-action" href="./features/workflow">查看运行流程</a>
    <a class="home-action" href="https://github.com/minori0721/Bili-favorites-backup" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
  </div>
</div>

![Bili-favorites-backup 主界面与全局设置](/screenshots/dashboard-desktop.png){.product-shot}

<p class="shot-caption">合成数据演示：账号、路径和BV号均不来自真实部署</p>

<div class="capability-strip">
  <section class="capability-item">
    <h2>云盘归档</h2>
    <p>BBDown下载后通过AList WebDAV写入国内网盘，多账号、多个收藏夹和多个目标分别保留归档证明。</p>
  </section>
  <section class="capability-item">
    <h2>可恢复</h2>
    <p>SQLite持久任务、aria2断点和下载会话共同保存进度，容器重启后继续未完成工作。</p>
  </section>
  <section class="capability-item">
    <h2>远端确认</h2>
    <p>上传成功不等于备份完成；系统会等待远端同名同大小文件可见后，才清理本地成品。</p>
  </section>
</div>

## 它适合什么场景

BFB适合把AList作为统一云盘入口、希望收藏夹内容持续留档，并且在意上传后能否真正找回文件的用户。它不是在线播放媒体库，也不会替你购买充电权限或绕过B站访问限制。

<div class="workflow-line">
  <span>收藏夹扫描</span><i>→</i><span>BBDown + aria2</span><i>→</i><span>本地验证</span><i>→</i><span>AList WebDAV</span><i>→</i><span>远端确认</span>
</div>

## 从这里开始

- 第一次部署：阅读[5分钟 Docker 部署](./guide/docker)。
- 已经有AList：直接看[接入已有 AList](./alist/existing)。
- 想知道任务为何暂停：查看[异常熔断与恢复](./features/recovery)和[问题排查](./troubleshooting/docker-hub)。
- 准备升级或迁移：先读[迁移、备份与回滚](./operations/migration)。

::: warning 使用前须知
请持久化挂载`data`和`temp`，并立即修改默认管理员密码、会话密钥和AList密码。迁移包可能包含B站Cookie或APP token，不能公开分享。
:::
