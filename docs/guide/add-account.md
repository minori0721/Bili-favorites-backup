# 添加B站账号

在账号区域点击“添加B站账号”，使用B站客户端扫码并确认。BFB使用TV端扫码流程保存Cookie和APP access token，不要求手动粘贴浏览器Cookie。

## 扫码后会发生什么

- 账号及其可访问收藏夹写入`data/users.json`。
- Cookie和access token不会显示在普通页面或日志中。
- 账号启用后可参与收藏扫描、下载和充电视频权限探测。
- 相同UID重新扫码会重新关联历史关系并唤醒因账号失效而暂停的任务。

## 网页接口与APP接口

默认“网页接口”使用Web WBI。网页模式触发`v_voucher`后，全局下载暂停3分钟，再只放行一个任务探测；有APP token时，该任务可临时使用APP接口。

常驻“APP接口”要求**所有启用账号**都具有access token。勾选Hi-Res或杜比时，页面会自动切换到APP接口；后端也会拒绝`网页接口 + Hi-Res/杜比`的矛盾配置。

`v2.4.6`固定BBDown fork `bfb-2.0.1`，会为每个账号保存独立的APP设备标识，并使用PlayerUnite读取普通UGC的AVC、HEVC和AV1流。APP最高仅480P或低于明确请求档位时，BBDown只在WEB视频更高时合并WEB视频，APP音频保持不变；WEB比较失败不会让已经取得的APP结果失败。`v2.4.5`镜像继续使用`bfb-2.0.0`。

## 账号失效

账号卡片会显示授权健康状态。重新扫码前，依赖该账号的新下载会暂停；已有完整本地成品仍可按原目标补传到 AList / OpenList。

下一步：[完成首次同步](./first-sync)。
