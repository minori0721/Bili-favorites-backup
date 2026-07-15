# 首次登录

打开BFB的`3000`端口，使用Compose中配置的`ADMIN_USER`和`ADMIN_PASS`登录。登录接口按客户端IP限制：15分钟内最多5次失败，成功登录不累计。

## 登录后先检查

1. 顶部版本应显示类似`v2.4.2 · main@abcdef0`，点击可打开对应GitHub提交。
2. 打开“全局设置”，确认AList内部通信地址为`http://alist:5244`。
3. 修改AList用户名、密码和目标目录，使其与AList实际配置一致。
4. 下载并发建议先保持`1`，上传并发默认`2`。

## HTTPS与Secure Cookie

仅在BFB通过HTTPS反向代理访问时设置`COOKIE_SECURE=true`。纯HTTP局域网部署若开启它，浏览器不会发送会话Cookie，表现为登录后又跳回登录页。

## 登录失败过多

第6次失败会返回`429`并携带`Retry-After`。等待窗口结束即可恢复；不要通过重启容器反复试密码。

下一步：[添加B站账号](./add-account)。
