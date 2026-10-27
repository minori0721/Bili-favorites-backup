import type { DriveStep } from 'driver.js';
import { requireElement } from '../../shared/dom.js';

export type GuideKind = 'overview' | 'storage' | 'accounts' | 'favorites' | 'subscriptions' | 'manual' | 'reopen';

export function guideSteps(root: Document, kind: GuideKind, hasAccounts: boolean): DriveStep[] {
  const step = (selector: string, title: string, description: string): DriveStep => ({
    element: requireElement(root, selector, HTMLElement), popover: { title, description },
  });
  if (kind === 'reopen') return [{
    element: requireElement(root, '#onboardingHelpBtn', HTMLElement),
    popover: {title:'随时可以重看',description:'点击这里可以重新打开界面介绍和配置清单，想看几遍都可以。',side:'bottom',align:'end'},
  }];
  if (kind === 'overview') return [
    step('body > main > .workspace-rail [data-workspace-page="accounts"]', '账号与收藏夹', '在这里扫码登录 B站账号，再选择需要同步的收藏夹。已有账号也在这里管理。'),
    step('body > main > .workspace-rail [data-workspace-page="subscriptions"]', '按 UP 订阅投稿', '从关注列表、搜索或 UID 添加 UP。可以归档全部投稿、从指定时间开始，或只归档选中的视频。'),
    step('body > main > .workspace-rail [data-workspace-page="tasks"]', '查看进度与待处理事项', '下载、上传、远端核验都在这里。需要你决定的问题会单独列出；队列等待不等于已经备份完成。'),
    step('body > main > .workspace-rail [data-workspace-page="library"]', '在归档库查看结果', '浏览已归档的视频，按来源筛选和播放。删除时会核对其他来源是否还在使用同一份文件。'),
  ];
  if (kind === 'storage') return [
    step('#alistUrl', '填写内部通信地址', '填写 BFB 容器能够访问的 AList / OpenList 地址。远端网页访问地址是另一个选填项，两者用途不同。'),
    step('#alistUsername', '填写远端账号', '填写有权访问目标目录的 WebDAV 用户名，按远端实际要求设置。'),
    step('#alistPassword', '填写远端密码', '填写对应的 WebDAV 密码。引导不会读取或保存你的输入；修改后需要由你点击保存。'),
    step('#alistDest', '选择归档目录', '填写远端存储中的目标目录。已有归档需要改位置时，请使用路径迁移功能。'),
    step('#storageCheckBtn', '先检查连接', '由你点击执行只读检查，不会写入远端。通过只说明当前表单的连接可读取，不代表已保存或上传成功。'),
    step('#saveConfigBtn', '保存后生效', '确认设置后，由你点击“保存设置并生效”。引导的“下一步”不会替你保存或开始同步。'),
  ];
  if (kind === 'manual') return [step('[data-workspace-action="online"]', '选择单个视频归档', '打开在线内容，选择视频后单独归档。这个方式不需要配置自动归档来源，仍需可用账号和远端存储。')];
  if (!hasAccounts) return [step('#addUserBtn', '先添加 B站账号', '点击此处扫码登录。扫码窗口打开时引导会暂停，窗口关闭后再继续；也可以随时退出引导。')];
  if (kind === 'subscriptions') {
    const steps = [step('#upAddBtn', '添加 UP 订阅', '点击后选择授权账号，再从关注列表、搜索或 UID 添加 UP，并设置归档范围。窗口打开时引导会暂停。')];
    if (root.querySelector('[data-up-manage]')) steps.push(step('[data-up-manage]', '选择投稿与调整规则', '已有订阅可以在这里浏览投稿、勾选视频和调整规则。发现投稿不等于已经备份，完成状态以任务核验结果为准。'));
    return steps;
  }
  if (kind === 'favorites') return [step('#userList [data-action="favorites"]', '选择需要同步的收藏夹', '每个账号都有“选择同步收藏夹”入口。请使用需要归档的账号；进入后勾选收藏夹并确认，其他收藏夹不会因此启用。')];
  return [
    step('#userList .auth-health', '检查账号授权', '这里显示账号授权状态。需要重新登录时更新授权；暂停的账号不会继续自动同步。'),
    step('#userList [data-action="favorites"]', '选择同步收藏夹', '从这个入口选择要归档的收藏夹。这里的高亮以一个账号为例，你可以退出引导后管理其他账号。'),
  ];
}
