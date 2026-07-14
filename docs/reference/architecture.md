# 用户视角架构

BFB把B站、下载器、本地恢复区和AList连接成一条可观察、可中断恢复的链路。

<div class="workflow-line">
  <span>B站账号与收藏夹</span><i>→</i><span>BFB调度器</span><i>→</i><span>BBDown / aria2 / FFmpeg</span><i>→</i><span>本地会话</span><i>→</i><span>AList WebDAV</span><i>→</i><span>网盘</span>
</div>

## 持久化边界

- **SQLite**：视频、收藏夹关系、任务、远端文件、失败、冷却和画质重调。
- **配置与账号JSON**：用户设置、B站登录态和网页日志继续独立保存。
- **下载会话文件**：每个`temp/<BVID>/.bfb-download.json`记录分P CID、已验证输出和恢复信息，不保存Cookie、token或签名下载地址。
- **aria2控制文件**：负责字节级续传；损坏或资源长度变化时只重置对应轨道。

## 为什么既有SQLite又有会话文件

SQLite回答“下一项工作是什么”，会话文件回答“这个BV在磁盘上已经完成了什么”。把两者分开后，调度任务可以用事务和租约恢复，媒体文件也能在BBDown进程中断后按CID重新核对。

## 上传为什么分两步

AList接受PUT不代表网盘立即能列出文件。`remote_files`逐目标、逐文件保存预期路径、大小与确认状态；只有远端同名同大小文件可见，才允许清理本地成品。

## 关闭与崩溃

正常关闭最多等待20秒保存控制文件、释放租约并checkpoint WAL。异常退出时，SQLite租约过期后重新领取任务，aria2和会话清单继续恢复磁盘进度。
