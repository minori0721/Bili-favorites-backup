# 接入已有 AList / OpenList

已有 AList 或 OpenList 时，只部署 app 服务，并在 BFB 全局设置中填写远端 WebDAV 可达地址、账号、密码和目标目录。配置字段名仍保留 `alistUrl` 等历史名称，以兼容已有配置。

```yaml
services:
  app:
    image: minori0721/bili-favorites-backup:latest
    container_name: bili-favorites-backup
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ADMIN_USER=${ADMIN_USER:-admin}
      - ADMIN_PASS=${ADMIN_PASS:-please-change-admin-pass}
      - SESSION_SECRET=${SESSION_SECRET:-please-change-session-secret}
      - ALLOW_COOKIE_EXPORT=${ALLOW_COOKIE_EXPORT:-false}
    volumes:
      - ./data:/app/data
      - ./temp:/app/temp
```

## 地址怎么填

- 同一 Docker 网络：优先使用服务名，例如 `http://alist:5244` 或 `http://openlist:5244`。
- 同一局域网：例如`http://192.168.1.100:5244`。
- 公网或反向代理：使用真实HTTPS地址，并确认WebDAV方法未被代理拦截。

不要填写只在浏览器本机有效的`127.0.0.1`；对app容器来说，它指向app容器自己。

## 最小权限

远端 WebDAV 账号必须能在目标目录执行：列出、创建目录、PUT 上传、MOVE 重命名、DELETE 删除和读取文件属性。缺少 MOVE 会影响历史归档与画质替换；缺少 DELETE 会让画质清理持续重试但不会删除本地新版。OpenList 还需要为该账号授予对应挂载的 WebDAV 管理权限。

不同驱动可能返回非标准状态码。BFB 会在 PUT 返回 405 后复核精确路径：只有文件已落盘且大小一致才确认成功；文件不存在或大小冲突仍会失败。

下一步：[添加网盘与WebDAV路径](./storage)。
