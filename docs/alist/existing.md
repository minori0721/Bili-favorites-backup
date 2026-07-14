# 接入已有AList

已有AList时，只部署app服务，并在BFB全局设置中填写AList可达地址、账号、密码和目标目录。

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

- 同一Docker网络：优先使用服务名，例如`http://alist:5244`。
- 同一局域网：例如`http://192.168.1.100:5244`。
- 公网或反向代理：使用真实HTTPS地址，并确认WebDAV方法未被代理拦截。

不要填写只在浏览器本机有效的`127.0.0.1`；对app容器来说，它指向app容器自己。

## 最小权限

AList账号必须能在目标目录执行：列出、创建目录、PUT上传、MOVE重命名、DELETE删除和读取文件属性。缺少MOVE会影响历史归档与画质替换；缺少DELETE会让画质清理持续重试但不会删除本地新版。

下一步：[添加网盘与WebDAV路径](./storage)。
