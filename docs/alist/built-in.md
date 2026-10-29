# 使用内置 AList

标准 Compose 中的服务名是 `alist`，因此 BFB 设置里的远端内部通信地址保持：

```text
http://alist:5244
```

这不是浏览器访问地址，而是 Docker 网络内 app 容器访问内置 AList 的地址。浏览器仍通过宿主机的`5244`端口打开 AList 后台。

## 必须持久化

```yaml
volumes:
  - ./alist:/opt/alist/data
```

这里保存 AList 账号、存储驱动和配置。删除该目录等同于重置 AList；BFB 的 SQLite 无法代替它。OpenList 不使用这个内置服务目录，外接 OpenList 的数据由 OpenList 自己持久化。

## 初始管理员密码

Compose 通过 `ALIST_ADMIN_PASSWORD` 传入初始密码。部署后请确认能登录 AList，并根据 AList 版本行为完成管理员密码设置。

::: info 内置版本
项目 Compose 固定 `xhofe/alist:v3.61.0`。使用 OpenList 时可连接已有实例；接入后先用一个小视频确认上传、播放和清理正常。
:::

下一步：[添加网盘与WebDAV路径](./storage)。
