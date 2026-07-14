# 使用内置AList

标准Compose中的服务名是`alist`，因此BFB设置里的“AList内部通信地址”保持：

```text
http://alist:5244
```

这不是浏览器访问地址，而是Docker网络内app容器访问AList的地址。浏览器仍通过宿主机的`5244`端口打开AList后台。

## 必须持久化

```yaml
volumes:
  - ./alist:/opt/alist/data
```

这里保存AList账号、存储驱动和配置。删除该目录等同于重置AList；BFB的SQLite无法代替它。

## 初始管理员密码

Compose通过`ALIST_ADMIN_PASSWORD`传入初始密码。部署后请确认能登录AList，并根据AList版本行为完成管理员密码设置。

::: warning 版本边界
项目Compose固定`xhofe/alist:v3.61.0`，不使用`latest`。该版本仍需按你的具体网盘驱动验证PUT、MOVE、列出、下载和删除。
:::

下一步：[添加网盘与WebDAV路径](./storage)。
