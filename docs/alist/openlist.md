# 接入 OpenList

BFB 通过标准 WebDAV 接口接入 OpenList。OpenList 与 AList 使用不同的项目维护和镜像，但对 BFB 来说都填写同一组兼容字段：内部通信地址、网页访问地址、WebDAV 用户名、WebDAV 密码和目标存储路径。

这表示“外接 OpenList”，不是把内置 Compose 中的 AList 服务替换成 OpenList。内置 Compose 仍然提供 AList；使用 OpenList 时只部署 BFB 的 `app` 服务，OpenList 的容器、数据目录、管理员账号和网盘挂载由 OpenList 自己维护。

## Docker 网络地址

如果 BFB 和 OpenList 在同一个 Compose 网络，内部通信地址填写 OpenList 的服务名和端口，例如：

```text
http://openlist:5244
```

如果 OpenList 运行在其他主机，则填写 BFB 容器能够访问的 HTTP/HTTPS 地址。不要填写只在浏览器本机有效的 `127.0.0.1`。

内部通信地址填写 WebDAV 服务的基础地址，例如 `http://openlist:5244`。BFB 会自动在这个地址后访问 `/dav`，因此不要手动把地址填成 `http://openlist:5244/dav/dav`。如果反向代理使用了基础路径，可以填写例如 `https://storage.example.com/openlist`，BFB 会访问对应的 `/openlist/dav`。

网页访问地址单独填写给播放器的“在网盘中查看”入口；它可以是 OpenList 根地址，也可以包含反向代理基础路径。内部通信地址和网页访问地址不要求相同。

## BFB 设置示例

在 BFB 的“全局设置”中按下面方式填写：

| 设置项 | 示例 | 说明 |
| --- | --- | --- |
| 远端内部通信地址 | `http://openlist:5244` | BFB 容器能访问的地址；不要重复添加 `/dav` |
| 远端网页访问地址 | `https://storage.example.com/openlist` | 可选，用于播放器的“在网盘中查看”入口 |
| 远端账号 | `bfb-webdav` | OpenList 中有目标挂载管理权限的 WebDAV 用户 |
| 远端密码 | 该用户的密码 | 不写入日志，也不会返回给浏览器播放器 |
| 目标存储路径 | `/阿里云盘/bili-backup/videos` | 必须是 OpenList 挂载后的远端路径 |

网页访问地址可以是 HTTP，但生产环境建议使用 HTTPS。网页地址不能包含用户名、密码、查询串或片段；反向代理基础路径可以保留。

## OpenList 权限

OpenList 后台需要为 WebDAV 账号授予目标存储的管理权限，至少验证以下动作：

1. PROPFIND 列出目录并读取文件大小。
2. MKCOL 创建目录。
3. PUT 上传文件。
4. GET/Range 播放或下载文件。
5. DELETE 删除已确认的文件。
6. MOVE 用于历史归档、重命名和画质替换。

BFB 保存的是远端文件证明，不会扫描 OpenList 全部存储。保存设置后先用小文件测试上传、大小确认、下载和删除，再开始批量同步。

建议先在一个临时目录完成下面的闭环，确认成功后再填写正式归档目录：

1. 在 OpenList 中确认 WebDAV 用户可以进入目标挂载和临时目录。
2. 在 BFB 保存设置，执行一个小视频或小文件上传。
3. 确认 BFB 显示“已上传·确认中”后，最终变为已验证。
4. 在 OpenList 中检查文件大小，并通过网页或 WebDAV 下载一次。
5. 只删除这个临时测试文件，再开始正式同步。

## 路径迁移边界

归档路径迁移会在真正复制前用随机临时文件探测 COPY 和 MOVE。COPY 不可用时，迁移会在开始前返回冲突，不会复制一半后才失败；MOVE 的探测结果独立记录，不会用 COPY 的结果猜测 MOVE。

不同 OpenList 版本和具体网盘驱动对 WebDAV 方法的支持可能不同。普通上传、读取、删除和播放可用，不代表挂载存储支持服务器端 COPY；不支持 COPY 时请保留原目录，改用新路径重新归档或手工迁移。

如果 COPY 不可用，请先保留现有归档路径。BFB 有远端证明时会保护 `alistDest`，不能直接改成新路径；不要为了绕过保护而清空 SQLite 或删除远端证明。确实需要迁移时，应先在远端管理界面完成独立、可核对的复制并保留原目录，再根据项目的迁移/回滚方案处理；BFB 不会把“下载到本地再重新上传”作为路径迁移的隐式回退。

## 常见结果

| 现象 | 含义 | 处理方式 |
| --- | --- | --- |
| 401 / 403 | WebDAV 用户不存在、密码错误或没有目标挂载权限 | 在 OpenList 检查用户、密码和挂载管理权限 |
| PUT 返回 405，但文件存在且大小一致 | 部分驱动写入成功后返回了错误状态 | BFB 会重新读取精确路径；大小一致时按上传成功处理 |
| 文件上传后长时间“确认中” | 远端驱动延迟显示，或无法返回准确大小 | 检查 OpenList 驱动、路径和文件大小接口，不要立即重复上传 |
| 路径迁移提示不支持 COPY | 当前挂载不支持服务器端复制 | 保留当前归档路径；不要直接改 `alistDest` |
| 播放回退到 BFB 代理 | OpenList 没有提供合格的外部 HTTPS 直链，或直链不安全 | 这是正常回退，播放器仍受 BFB 登录和文件证明保护 |

官方资料：[OpenList 文档](https://doc.oplist.org/) · [OpenList 项目](https://github.com/OpenListTeam/OpenList)

下一步：[添加网盘与 WebDAV 路径](./storage)。
