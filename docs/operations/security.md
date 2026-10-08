# 安全配置

BFB需要保存B站登录态和 AList / OpenList WebDAV 凭据。它适合在可信服务器或家庭网络运行，不应直接使用默认密码暴露到公网。

## 最低要求

- 修改`ADMIN_PASS`、`SESSION_SECRET`和`ALIST_ADMIN_PASSWORD`。
- 不需要Cookie导出时设置`ALLOW_COOKIE_EXPORT=false`。
- 通过HTTPS反向代理访问时设置`COOKIE_SECURE=true`。
- 反向代理部署显式设置`TRUST_PROXY`为实际代理IP/CIDR，不信任全部来源或固定跳数。
- 限制`3000`和`5244`端口的公网访问范围。
- 定期备份`data/`、`temp/`和内置 AList 的`alist/`；外接 OpenList 的数据目录由 OpenList 单独备份。

## 登录保护

`/api/login`按客户端IP限制15分钟内最多5次失败，成功请求不计数。弱配置只输出不含实际值的启动警告，不会自动阻止启动。

管理员登录使用服务端Session，浏览器只保存带签名的随机会话Cookie。SQLite会话库使用HMAC后的会话键，不保存管理员密码、B站Cookie或 AList / OpenList 凭据；主库及WAL侧文件在支持的平台上设置为`0600`。登录成功会重新生成会话ID，退出会同时清除浏览器Cookie和服务端记录。

普通会话以浏览器会话Cookie工作，并有24小时服务端硬上限；用户可主动选择固定保持30天。会话不滚动续期，每秒队列轮询不会写会话库。修改管理员账号、密码或`SESSION_SECRET`会撤销旧会话，每个管理员最多保留10个会话。

退出、到期、超过会话上限或应用关闭时，对应实时日志连接会关闭并释放订阅；其他会话和后台备份任务不受单个会话退出影响。到期检查使用原来的固定期限，不会续期，也不会因30天超过单个计时器上限而提前结束。

登录请求体上限为16 KiB，先检查同源与限流，再解析 JSON 或表单。超限返回`413`，损坏 JSON 返回`400`，不回显或记录请求体。受保护的业务 API 先认证、检查同源与维护准入，再使用原有请求体容量解析。

`data/auth-sessions.sqlite`不会进入迁移包或导入前自动备份。手工备份整个`data/`会包含它，因此仍应按敏感数据保护；会话数据库损坏时应用会保留损坏副本并创建空库，现有管理员会话随之注销。

## 反向代理与登录安全

::: warning 已有宝塔 / Nginx 部署更新前必读
新版本移除了默认的“一跳代理信任”。`TRUST_PROXY` 默认是 `false`，不会使用客户端提交的转发头决定 IP 或协议。反代用户必须显式配置可信来源；HTTPS 反代还需要 `COOKIE_SECURE=true`。配置缺失可能导致登录 `403`、限流按代理 IP 合并，或登录后无法保存会话。

**域名本身无需写入 BFB 配置。** 需要配置的是连接 BFB 的代理来源与转发规则。Docker 中该来源可能是桥接网关，并不一定是 `127.0.0.1`。
:::

| 访问方式 | `TRUST_PROXY` | `COOKIE_SECURE` |
| --- | --- | --- |
| IP 或域名直接访问 HTTP | `false`（默认） | `false`（默认） |
| 宝塔 / Nginx 代理 HTTPS | 实际代理 IP/CIDR | `true` |

### 1. 将配置传入应用容器

仓库 Compose 与文档示例已包含以下条目。自定义 Compose 时，将它们追加到现有 `app.environment`，保留镜像、账号配置和持久化挂载：

```yaml
environment:
  - TRUST_PROXY=${TRUST_PROXY:-false}
  - COOKIE_SECURE=${COOKIE_SECURE:-false}
```

随后在 Compose 同目录的 `.env` 设置值。**仅写 `.env`，却没有上述 `environment` 条目，不会将值传入应用。**

`TRUST_PROXY` 接受单个 IP、CIDR 或逗号分隔的多项地址；空值或 `false` 表示禁用。优先填写实际代理的单个地址，只有地址确实变化且来源受控时才使用小网段。不接受 `true`、数字跳数、主机名或覆盖所有地址的 `/0`，非法配置会阻止启动，错误不打印原始配置值。

例如，**只有确认 BFB 收到的代理连接来源确实是 `172.18.0.1` 时**，才使用：

```dotenv
TRUST_PROXY=172.18.0.1
COOKIE_SECURE=true
```

上面的地址只是示例，不是通用 Docker 默认值。宿主机 Nginx 连接映射端口、同网络代理容器，以及直接运行 Node 的来源地址可能不同；Docker 网络的网关地址只是排查线索，应核对实际连接来源后填写。代理有多层时，按真实链路配置受控来源，每个入口代理都必须清理客户端提供的转发头。

### 2. 让代理转发原始域名、端口和协议

对于“浏览器 → 同一台机器的宝塔 / Nginx → BFB”这一层代理，修改已有站点的代理 `location`，不要另外添加重复的 `location /`。下面示例假定 BFB 映射到宿主机 `3007` 端口；实际端口不同则替换：

```nginx
location / {
    proxy_pass http://127.0.0.1:3007;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_http_version 1.1;
    proxy_buffering off;
}
```

该示例覆盖转发头，不沿用浏览器提交的 `X-Forwarded-For`。`$http_host` 保留域名和非默认端口；`$scheme` 表示浏览器到这一层 Nginx 的协议。宝塔站点的 HTTPS 证书仍在宝塔中配置。`proxy_buffering off` 让实时日志及时到达浏览器。

若 Nginx 前面还有 CDN 或另一层代理，不能直接套用单层示例；应先确定哪个受控入口提供客户端 IP 与原始协议。BFB 只在来源可信时使用转发 IP 和协议，同源校验仍要求 `Host` 保留浏览器使用的域名与端口。

### 3. 限制绕过代理，并让环境变量生效

启用代理信任后，应将 BFB 的源端口限制为只允许代理访问。尤其是将 Docker 桥接网关列为可信来源时，仅填写网关地址不能代替网络隔离；需要确认绕过代理的连接不会同样被转成可信来源。若代理确实运行在同一宿主机，可将端口映射改为 `"127.0.0.1:3007:3000"`；**这会停止通过公网 IP 的 `3007` 端口直接访问**。代理运行在其他容器或机器时，应按实际网络限制来源，不能直接采用此映射。

修改 Compose 环境变量后使用 `docker compose up -d app` 重建应用容器；仅 `restart` 不会读取新的环境变量。保持 `data/`、`temp/` 等挂载不变，不需要清空数据。

启动日志会输出代理信任是否启用、可信来源数量及 Cookie 模式，不输出密码、会话密钥或原始代理地址。更新后检查 `/login`，完成一次登录、打开实时日志，再退出确认会话失效。

### 登录异常怎么判断

- `403`：核对浏览器协议、域名、端口，以及代理的 `Host` / `X-Forwarded-Proto`；确认 `TRUST_PROXY` 填的是实际连接来源。
- 登录后又回到登录页：检查是否在 HTTP 下开启 `COOKIE_SECURE`，或 HTTPS 反代未被信任，导致应用不能设置 Secure Cookie。
- 多人共用同一个限流额度：通常是代理来源未被信任，或客户端 IP 未正确转发；不要用 `TRUST_PROXY=true` 或信任全部网段来绕过。

配置依据：[Express 代理信任说明](https://expressjs.com/en/guide/behind-proxies/)与[Nginx 转发头说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。

## 临时凭据

BBDown配置写入系统临时目录中的`bfb-credentials-*`，目录权限`0700`、文件权限`0600`。应用启动和正常关闭会清理遗留目录；迁移导出排除凭据，旧迁移包中的历史凭据目录也不会恢复。

## 不要公开的内容

- `.env`、`data/users.json`、完整迁移包。
- BBDown凭据目录、Cookie导出结果。
- 未经人工复核的原始日志和Debug日志。
- 含真实 AList / OpenList 地址、网盘路径或服务器IP的截图。

BFB的日志脱敏降低泄漏风险，但不能替代部署权限、网络隔离和人工检查。
