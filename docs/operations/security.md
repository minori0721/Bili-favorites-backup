# 安全配置

BFB需要保存B站登录态和AList凭据。它适合在可信服务器或家庭网络运行，不应直接使用默认密码暴露到公网。

## 最低要求

- 修改`ADMIN_PASS`、`SESSION_SECRET`和`ALIST_ADMIN_PASSWORD`。
- 不需要Cookie导出时设置`ALLOW_COOKIE_EXPORT=false`。
- 通过HTTPS反向代理访问时设置`COOKIE_SECURE=true`。
- 限制`3000`和`5244`端口的公网访问范围。
- 定期备份`data/`、`temp/`和内置AList的`alist/`。

## 登录保护

`/api/login`按客户端IP限制15分钟内最多5次失败，成功请求不计数。弱配置只输出不含实际值的启动警告，不会自动阻止启动。

## 临时凭据

BBDown配置写入系统临时目录中的`bfb-credentials-*`，目录权限`0700`、文件权限`0600`。应用启动和正常关闭会清理遗留目录；迁移导出排除凭据，旧迁移包中的历史凭据目录也不会恢复。

## 不要公开的内容

- `.env`、`data/users.json`、完整迁移包。
- BBDown凭据目录、Cookie导出结果。
- 未经人工复核的原始日志和Debug日志。
- 含真实AList地址、网盘路径或服务器IP的截图。

BFB的日志脱敏降低泄漏风险，但不能替代部署权限、网络隔离和人工检查。
