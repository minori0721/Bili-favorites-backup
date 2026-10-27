import {revealControl} from './workspace-navigation.js';
import { expect,test,type Page } from '@playwright/test';

const shared='BVUP163637592X001';
test.beforeEach(async({page})=>{
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  await page.goto('/?page=accounts');
});
async function manage(page:Page,bvid=shared) {
  await (await revealControl(page,page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'归档库',exact:true}))).click();
  await (await revealControl(page,page.locator('.archive-nav-item[data-archive-scope="global"]'))).click();
  const card=page.locator(`[data-archive-bvid="${bvid}"]`);
  await expect(card).toBeVisible();await (await revealControl(page,card.locator('.archive-library-card-more'))).click();
  const source=page.locator('.archive-library-source').filter({hasText:'收藏夹 A · 日常'});
  await (await revealControl(page,source.getByRole('button',{name:'管理归档',exact:true}))).click();
  await expect(page.locator('#upActionPreviewBtn')).toBeEnabled();
  await expect(page.locator('#archiveActionCurrentSource')).toContainText('收藏夹 A');
}
async function confirmDeletion(page:Page) {
  await expect(page.locator('#confirmActionModal')).toHaveClass(/active/);
  await expect(page.locator('#confirmActionModal')).toHaveAttribute('aria-modal','true');
  await (await revealControl(page,page.locator('#confirmActionInput'))).fill('DELETE ARCHIVE');
  await expect(page.locator('#confirmActionOkBtn')).toBeEnabled();
  await (await revealControl(page,page.locator('#confirmActionOkBtn'))).click();
}
test('favorite and UP share a safe management flow; a shared source deletion keeps the other playable sources',async({page})=>{
  await manage(page);
  const dialog=page.locator('#upActionModal');
  await expect(page.locator('#archiveActionRule')).toContainText('未在当前来源中排除');
  await expect(dialog).toContainText('保留归档，排除此视频');
  await expect(dialog).toContainText('其他视频不受影响');
  await expect(dialog.locator('input[name=upScope][value=source]')).toBeChecked();
  await expect(dialog.locator('input[name=upEffect][value=retain]')).toBeChecked();
  await (await revealControl(page,dialog.locator('input[name=upEffect][value=delete]'))).check();
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();
  await expect(page.locator('#confirmActionDetail')).toContainText('预计实际删除 0 个文件');
  await expect(page.locator('#confirmActionDetail')).toContainText('共享保留 1 个');
  await expect(page.locator('#confirmActionDetail')).toContainText('收藏夹 B');
  await expect(page.locator('#confirmActionDetail')).toContainText('何同学');
  await (await revealControl(page,page.locator('#confirmActionCancelBtn'))).click();
  await expect(page.locator('#upActionStatus')).toContainText('尚未提交');
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();await confirmDeletion(page);
  await expect(page.locator('#upActionStatus')).toContainText('清理完成');
  await expect(page.locator('#archiveActionUnblock')).toBeVisible();
  const response=await page.request.get(`/api/archive-library/items/${shared}?scope=global`);const data=(await response.json()).data;
  expect(data.memberships.filter((source:{backupStatus:string})=>source.backupStatus==='verified')).toHaveLength(2);
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
});
test('selected source preview names each target and distinguishes an independent copy from the same BV elsewhere',async({page})=>{
  await manage(page,'BVARCHIVECOPIES');
  await (await revealControl(page,page.locator('input[name=upScope][value=selected]'))).check();
  await expect(page.locator('#archiveActionSources label')).toHaveCount(2);
  await (await revealControl(page,page.locator('input[name=upEffect][value=delete]'))).check();
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();
  await expect(page.locator('#confirmActionMessage')).toContainText('收藏夹 A');
  await expect(page.locator('#confirmActionDetail')).toContainText('预计实际删除 1 个文件');
  await expect(page.locator('#confirmActionDetail')).toContainText('收藏夹 B');
  await confirmDeletion(page);await expect(page.locator('#upActionStatus')).toContainText('清理完成');
});
test('global exclusion is explicit, can be undone, and does not imply that physical files were deleted',async({page})=>{
  await manage(page);
  await (await revealControl(page,page.locator('input[name=upScope][value=global]'))).check();
  await expect(page.locator('#archiveActionScopeHint')).toContainText('以后新发现');
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();await expect(page.locator('#confirmActionDetail')).toContainText('已有文件与播放能力保留');
  await (await revealControl(page,page.locator('#confirmActionOkBtn'))).click();await expect(page.locator('#archiveActionUnblockGlobal')).toBeVisible();
  await expect(page.locator('#upActionStatus')).toContainText('已有文件保留');
  await (await revealControl(page,page.locator('#archiveActionUnblockGlobal'))).click();await (await revealControl(page,page.locator('#confirmActionOkBtn'))).click();
  await expect(page.locator('#archiveActionRule')).toContainText('未在当前来源中排除');
});

test('a delayed cleanup response cannot overwrite the next exclusion action',async({page})=>{
  let release:()=>void=()=>{};
  let received:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;});
  const requested=new Promise<void>(resolve=>{received=resolve;});
  await page.route('**/api/archive-deletions/*',async route=>{
    const response=await route.fetch();received();await held;await route.fulfill({response});
  });
  await manage(page);await (await revealControl(page,page.locator('input[name=upEffect][value=delete]'))).check();
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();await confirmDeletion(page);await requested;
  await expect(page.locator('#upActionPreviewBtn')).toBeEnabled();
  await (await revealControl(page,page.locator('input[name=upEffect][value=retain]'))).check();
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();await (await revealControl(page,page.locator('#confirmActionOkBtn'))).click();
  await expect(page.locator('#upActionStatus')).toContainText('已有文件保留');
  const delivered=page.waitForResponse(response=>response.url().includes('/api/archive-deletions/'));
  release();await delivered;
  // Let the released response reach the controller before checking the stable message.
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.locator('#upActionStatus')).toContainText('已有文件保留');
});
test('failed cleanup reports failure while retaining the source exclusion',async({page})=>{
  await page.request.post('/__test/up-deletion-failure',{data:{enabled:true}});
  await manage(page,'BVARCHIVECOPIES');await (await revealControl(page,page.locator('input[name=upEffect][value=delete]'))).check();
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();await confirmDeletion(page);
  await expect(page.locator('#upActionStatus')).toContainText('清理未完成');
  await expect(page.locator('#archiveActionRule')).toContainText('此视频已在当前来源中排除');
});
test('cleanup separates rollback data, blocks busy cover deletion, and does not suggest wiping data for a container update',async({page})=>{
  await page.request.post('/__test/cleanup-busy',{data:{busy:true}});
  await (await revealControl(page,page.locator('#cleanupDataBtn'))).click();
  await expect(page.locator('.cleanup-check[value=covers]')).toBeDisabled();
  await expect(page.locator('.cleanup-check[value=logs]')).toBeEnabled();
  await expect(page.locator('#cleanupList')).toContainText('高风险');
  await (await revealControl(page,page.locator('.cleanup-check[value=backups]'))).check();
  await expect(page.locator('#cleanupConfirmHint')).toContainText('回滚备份也会永久删除');
  await (await revealControl(page,page.locator('#cleanupHelpBtn'))).click();
  await expect(page.locator('#cleanupHelpModal')).toContainText('不需要先清理项目数据');
});
test('quality replacement counts unique videos separately from their selected archive sources',async({page})=>{
  await (await revealControl(page,page.locator('#qualityUpgradeBtn'))).click();
  await expect(page.locator('#qualityUpgradeList .rename-item')).toHaveCount(2);
  await (await revealControl(page,page.locator('#qualityUpgradeSelectAllBtn'))).click();
  await (await revealControl(page,page.locator('#executeQualityUpgradeBtn'))).click();
  await expect(page.locator('#confirmActionMessage')).toContainText('1 个视频、2 个归档来源');
  await expect(page.locator('#confirmActionDetail')).toContainText('收藏夹 A');
  await expect(page.locator('#confirmActionDetail')).toContainText('收藏夹 B');
  await (await revealControl(page,page.locator('#confirmActionCancelBtn'))).click();
});

test('failed cleanup can stop from the common manager before rules are restored, retaining the media proof',async({page})=>{
  await page.request.post('/__test/up-deletion-failure',{data:{enabled:true}});
  await manage(page,'BVARCHIVECOPIES');await (await revealControl(page,page.locator('input[name=upEffect][value=delete]'))).check();
  await (await revealControl(page,page.locator('#upActionPreviewBtn'))).click();await confirmDeletion(page);
  await expect(page.locator('#archiveActionStop')).toBeVisible();await expect(page.locator('#upActionPreviewBtn')).toBeDisabled();await expect(page.locator('#archiveActionUnblock')).toBeDisabled();
  await (await revealControl(page,page.locator('#archiveActionStop'))).click();await expect(page.locator('#confirmActionModal')).toHaveAttribute('aria-modal','true');
  await expect(page.locator('#confirmActionDetail')).toContainText('已经删除的文件不会恢复');
  await (await revealControl(page,page.locator('#confirmActionInput'))).fill('STOP ARCHIVE CLEANUP');await (await revealControl(page,page.locator('#confirmActionOkBtn'))).click();
  await expect(page.locator('#upActionStatus')).toContainText('已停止剩余清理');await expect(page.locator('#archiveActionUnblock')).toBeEnabled();
  await (await revealControl(page,page.locator('#archiveActionUnblock'))).click();await (await revealControl(page,page.locator('#confirmActionOkBtn'))).click();
  await expect(page.locator('#archiveActionRule')).toContainText('未在当前来源中排除');
  const detail=await(await page.request.get('/api/archive-library/items/BVARCHIVECOPIES?scope=global')).json();
  expect(detail.data.memberships.filter((item:{backupStatus:string})=>item.backupStatus==='verified')).toHaveLength(2);
});
