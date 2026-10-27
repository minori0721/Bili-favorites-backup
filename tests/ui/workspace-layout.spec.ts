import {expect,test,type Page} from '@playwright/test';

test.beforeEach(async({page})=>{
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true,queueBoardMode:'media_retry',recoveryIssueKind:'download'}});
});
async function boot(page:Page){await page.goto('/?page=overview');await expect(page.locator('#workspaceSubscriptions')).toHaveText('3');}
async function navigate(page:Page,name:string){await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name,exact:true}).click();}
async function category(page:Page,name:string){
  const picker=page.getByRole('combobox',{name:'设置分类'});
  if(await picker.isVisible())await picker.selectOption({label:name});
  else await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name,exact:true}).click();
}
async function selectedCategory(page:Page,name:string){
  const picker=page.getByRole('combobox',{name:'设置分类'});
  if(await picker.isVisible())await expect(picker.locator('option:checked')).toHaveText(name);
  else await expect(page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name,exact:true})).toHaveAttribute('aria-pressed','true');
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function returnFromArchive(page:Page){
  await expect(page.locator('#archiveLibraryFooter')).toHaveText('已加载全部');
  const close=page.locator('#closeArchiveLibraryBtn');
  if(!await close.isVisible()){
    await page.locator('#archiveLibraryMobileBackBtn').click();
    await expect(close).toBeVisible();
  }
  await close.click();
}

test('overview uses actual fixture values, keeps original theme and navigates between panels',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await boot(page);await expect(page.locator('#workspaceRunning')).toHaveText('0');await expect(page.locator('#workspaceWaiting')).toHaveText('1');
  await expect(page.locator('#settingsSection')).toBeHidden();await noOverflow(page);
  expect(await page.locator('body').evaluate(node=>getComputedStyle(node).getPropertyValue('--accent').trim())).toBe('#39C5BB');
  const avatar=await page.locator('.workspace-source-row .up-avatar').first().boundingBox();expect(avatar?.width).toBeLessThanOrEqual(36);
  await page.screenshot({path:info.outputPath('overview.png'),fullPage:true});
  await navigate(page,'任务');await expect(page.locator('#queueBoard')).toBeVisible();await expect(page.locator('.workspace-overview')).toBeHidden();await noOverflow(page);
  await navigate(page,'账号');await expect(page.locator('.account-section')).toBeVisible();await expect(page.locator('#queueBoard')).toBeHidden();
  expect(errors).toEqual([]);
});

test('settings categories preserve the unsaved draft across main navigation',async({page},info)=>{
  await boot(page);await navigate(page,'设置');
  await category(page,'远端存储与播放');
  await page.locator('#alistUrl').fill('http://isolated-workspace.invalid:5244');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await navigate(page,'账号');await navigate(page,'设置');
  await expect(page.locator('#alistUrl')).toHaveValue('http://isolated-workspace.invalid:5244');
  await expect(page.locator('#pollInterval')).toBeHidden();await noOverflow(page);
  await page.screenshot({path:info.outputPath('settings.png'),fullPage:true});
  await category(page,'同步节奏');
  await expect(page.locator('#pollInterval')).toBeVisible();
});

test('account secondary actions remain discoverable and cookie export still requires confirmation',async({page})=>{
  await boot(page);await navigate(page,'账号');
  await expect(page.locator('button[data-action=copy_cookie]')).toBeHidden();
  await page.locator('.user-actions .workspace-more > summary').click();
  const cookie=page.locator('button[data-action=copy_cookie]');await expect(cookie).toBeVisible();await noOverflow(page);
  await cookie.click();await expect(page.locator('#confirmActionModal')).toHaveClass(/active/);
  await expect(page.locator('#confirmActionModal')).toContainText('EXPORT_COOKIE');
  await page.locator('#confirmActionCancelBtn').click();
});

test('UP work area has navigable page framing and contextual selection actions',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await boot(page);await navigate(page,'UP 订阅');
  await page.locator('#upHomeList [data-up-manage]').first().click();
  const workspace=page.locator('#upWorkspaceModal');await expect(workspace).toHaveClass(/workspace-full-workspace/);
  await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  await expect(page.locator('#upIncludeBtn')).toBeHidden();
  await page.locator('#upCatalogList input[data-up-video]').first().check();
  await expect(workspace).toHaveClass(/workspace-has-selection/);
  await expect(page.locator('#upIncludeBtn')).toBeVisible();
  await noOverflow(page);await page.screenshot({path:info.outputPath('up-workspace.png'),fullPage:true});
  await workspace.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'任务',exact:true}).click();
  await expect(workspace).toBeHidden();await expect(page.locator('#queueBoard')).toBeVisible();
  expect(errors).toEqual([]);
});

test('archive workspace can return through main navigation without leaving a modal lock',async({page},info)=>{
  await boot(page);await navigate(page,'归档库');
  const workspace=page.locator('#archiveLibraryModal');await expect(workspace).toHaveClass(/workspace-full-workspace/);
  await expect(workspace.getByRole('navigation',{name:'主导航',exact:true})).toBeVisible();
  await noOverflow(page);await page.screenshot({path:info.outputPath('archive-workspace.png'),fullPage:true});
  await workspace.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'概览',exact:true}).click();
  await expect(workspace).toBeHidden();await expect(page.locator('body > main')).not.toHaveAttribute('inert','');
  await expect(page.locator('.workspace-overview')).toBeVisible();
});

test('browser back restores the previous section',async({page})=>{
  await boot(page);await navigate(page,'账号');await navigate(page,'设置');await page.goBack();
  await expect(page.locator('.account-section')).toBeVisible();await expect(page.locator('#settingsSection')).toBeHidden();
});

test('nested UP to archive navigation closes workspaces in stack order and retains deletion confirmation',async({page})=>{
  await boot(page);await navigate(page,'UP 订阅');
  await page.locator('#upHomeList .up-subscription-card').filter({hasText:'老师好我叫何同学'}).locator('[data-up-manage]').click();
  await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  await page.locator('#upCatalogList .up-video').first().getByRole('button',{name:'管理归档',exact:true}).click();
  await expect(page.locator('#upActionModal')).toHaveAttribute('aria-modal','true');
  await expect(page.locator('#upActionModal')).toContainText('影响范围');
  await page.locator('[data-archive-action-close]').click();
  await expect(page.locator('#upActionModal')).toBeHidden();
  await page.locator('#upOpenArchiveBtn').click();
  const archive=page.locator('#archiveLibraryModal');await expect(archive).toHaveAttribute('aria-modal','true');
  await archive.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'任务',exact:true}).click();
  await expect(page.locator('#upWorkspaceModal')).toBeHidden();await expect(archive).toBeHidden();
  await expect(page.locator('#queueBoard')).toBeVisible();await expect(page.locator('body > main')).not.toHaveAttribute('inert','');
});

test('pending and failed queue reads never become a false zero-task success',async({page})=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/queue/state',async route=>{await gate;await route.fulfill({status:503,json:{success:false,message:'隔离队列读取失败'}});});
  await boot(page);await expect(page.locator('#workspaceRunning')).toHaveText('—');await expect(page.locator('#workspaceWaiting')).toHaveText('—');
  release();await expect(page.locator('#workspaceAttentionTitle')).toHaveText('队列状态读取失败');
  await expect(page.locator('#workspaceRunning')).toHaveText('—');await noOverflow(page);
});

test('settings save follows every field and maintenance has its own category',async({page},info)=>{
  await boot(page);await navigate(page,'设置');
  await category(page,'队列与重试');
  const actions=page.locator('#settingsSection .settings-actions');
  expect(await actions.evaluate(node=>getComputedStyle(node).position)).toBe('static');
  const last=page.locator('#remoteRequeueLimitPerCycle');
  const lastBox=await last.boundingBox(),actionsBox=await actions.boundingBox();
  expect(actionsBox!.y).toBeGreaterThan(lastBox!.y+lastBox!.height);
  await last.scrollIntoViewIfNeeded();
  expect(await last.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===node;})).toBe(true);
  await page.screenshot({path:info.outputPath('settings-footer-fixed.png'),fullPage:true});
  await category(page,'维护与迁移');
  await expect(page.locator('#saveConfigBtn')).toBeHidden();
  await expect(page.locator('#migrationBtn')).toBeVisible();
  await expect(page.locator('#cleanupDataBtn')).toBeVisible();await noOverflow(page);
  await category(page,'同步节奏');
  await expect(page.locator('#saveConfigBtn')).toBeVisible();await expect(page.locator('#migrationBtn')).toBeHidden();
});

test('saving invalid settings reveals the hidden category and focuses the field without submitting',async({page})=>{
  const writes:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/config')writes.push(request.url());});
  await boot(page);await navigate(page,'设置');
  await category(page,'队列与重试');
  await page.locator('#maxRetries').fill('-1');
  await category(page,'同步节奏');
  await page.locator('#saveConfigBtn').click();
  await selectedCategory(page,'队列与重试');
  await expect(page.locator('#maxRetries')).toBeFocused();
  await expect(page.locator('#configStatus')).toContainText('失败重试次数');
  expect(writes).toEqual([]);
  await page.locator('#maxRetries').fill('3');await expect(page.locator('#configStatus')).toBeEmpty();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
});

test('archive return restores the originating settings draft category scroll and route',async({page})=>{
  await boot(page);await navigate(page,'设置');
  await category(page,'远端存储与播放');
  await page.locator('#alistBrowserUrl').fill('https://workspace-only.invalid');
  await page.locator('#playbackDeliveryMode').scrollIntoViewIfNeeded();
  const scroll=await page.evaluate(()=>scrollY);
  await navigate(page,'归档库');await expect(page.locator('#archiveLibraryModal')).toHaveAttribute('aria-modal','true');
  await returnFromArchive(page);
  await expect(page.locator('#archiveLibraryModal')).toBeHidden();
  await expect(page).toHaveURL(/page=settings/);
  await expect(page.locator('#settingsSection')).toBeVisible();
  await expect(page.locator('body > main .workspace-rail [aria-current=page]')).toHaveText('设置');
  await expect(page.locator('#alistBrowserUrl')).toHaveValue('https://workspace-only.invalid');
  await selectedCategory(page,'远端存储与播放');
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeCloseTo(scroll,0);
});

test('nested archive return keeps the selected UP work area and restores its navigation',async({page})=>{
  await boot(page);await navigate(page,'UP 订阅');
  await page.locator('#upHomeList [data-up-manage]').first().click();
  await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  await page.locator('#upCatalogList input[data-up-video]').first().check();
  await page.locator('#upOpenArchiveBtn').click();
  await expect(page.locator('#archiveLibraryModal')).toHaveAttribute('aria-modal','true');
  await returnFromArchive(page);
  await expect(page.locator('#upWorkspaceModal')).toHaveAttribute('aria-modal','true');
  await expect(page).toHaveURL(/page=subscriptions/);
  await expect(page.locator('#upCatalogList input[data-up-video]').first()).toBeChecked();
  await expect(page.locator('#upWorkspaceModal .workspace-rail [aria-current=page]')).toHaveText('UP 订阅');
  await page.locator('#upWorkspaceModal [data-up-close="upWorkspaceModal"]').click();
  await expect(page.locator('#upWorkspaceModal')).toBeHidden();
  await expect(page.locator('#upSubscriptionsSection')).toBeVisible();
  await expect(page.locator('body > main .workspace-rail [aria-current=page]')).toHaveText('UP 订阅');
});

test('main navigation remains usable at the end of a long settings page',async({page})=>{
  await boot(page);await navigate(page,'设置');
  await category(page,'远端存储与播放');
  await page.locator('#saveConfigBtn').scrollIntoViewIfNeeded();
  const nav=page.getByRole('navigation',{name:'主导航',exact:true});
  const box=await nav.boundingBox(),height=await page.evaluate(()=>innerHeight);
  expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.y+box!.height).toBeLessThanOrEqual(height);
  const navY=box!.y;
  await nav.getByRole('button',{name:'任务',exact:true}).click();
  await expect(page.locator('#queueBoard')).toBeVisible();await noOverflow(page);
  expect(Math.abs((await page.getByRole('navigation',{name:'主导航',exact:true}).boundingBox())!.y-navY)).toBeLessThan(1);
});

test('Escape and browser back both restore a consistent workspace route',async({page})=>{
  await boot(page);await navigate(page,'账号');await navigate(page,'归档库');
  await expect(page.locator('#archiveLibraryModal')).toHaveAttribute('aria-modal','true');
  await page.keyboard.press('Escape');await expect(page.locator('#archiveLibraryModal')).toBeHidden();
  await expect(page).toHaveURL(/page=accounts/);
  await expect(page.locator('body > main .workspace-rail [aria-current=page]')).toHaveText('账号');
  await navigate(page,'设置');await navigate(page,'归档库');
  await expect(page.locator('#archiveLibraryModal')).toHaveAttribute('aria-modal','true');
  await page.goBack();await expect(page.locator('#archiveLibraryModal')).toBeHidden();
  await expect(page).toHaveURL(/page=settings/);await expect(page.locator('#settingsSection')).toBeVisible();
  await expect(page.locator('body > main .workspace-rail [aria-current=page]')).toHaveText('设置');
});

test('maintenance actions keep the home button theme and open the original cleanup confirmation',async({page},info)=>{
  if(info.project.name==='desktop')await page.setViewportSize({width:952,height:764});
  await boot(page);await navigate(page,'设置');
  await category(page,'维护与迁移');
  const buttons=page.locator('.workspace-maintenance-row button');await expect(buttons).toHaveCount(5);
  const styles=await buttons.evaluateAll(nodes=>nodes.map(node=>{const style=getComputedStyle(node);return {radius:parseFloat(style.borderRadius),height:node.getBoundingClientRect().height,font:style.fontFamily,color:style.color,background:style.backgroundColor};}));
  const bodyFont=await page.locator('body').evaluate(node=>getComputedStyle(node).fontFamily);
  for(const style of styles){expect(style.radius).toBe(12);expect(style.height).toBeGreaterThanOrEqual(44);expect(style.font).toBe(bodyFont);expect(style.background).not.toBe('rgb(239, 239, 239)');}
  expect(styles.slice(0,4).every(style=>style.color==='rgb(36, 118, 111)')).toBe(true);
  expect(styles[4].color).toBe('rgb(185, 71, 71)');await noOverflow(page);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:info.outputPath('maintenance-polished.png'),fullPage:true});
  await page.locator('#cleanupDataBtn').click();await expect(page.locator('#cleanupDataModal')).toHaveAttribute('aria-modal','true');
  await expect(page.locator('#cleanupDataModal')).toContainText('不会删除远端网盘视频');
  await page.keyboard.press('Escape');await expect(page.locator('#cleanupDataModal')).toBeHidden();
});

test('recovery workspace has a labeled return control and shows its count only in the list',async({page},info)=>{
  if(info.project.name==='desktop')await page.setViewportSize({width:952,height:764});
  await boot(page);await navigate(page,'任务');await page.locator('#recoveryIssuesBtn').click();
  const modal=page.locator('#recoveryIssuesModal');await expect(modal).toHaveAttribute('aria-modal','true');
  await expect(page.locator('#recoveryIssuesListCount')).toHaveText('1 项');await expect(page.locator('#recoveryIssuesSummary')).toBeHidden();
  const back=page.locator('#closeRecoveryIssuesBtn');await expect(back).toHaveAccessibleName('返回任务');
  await expect(back.locator('span')).toHaveText('返回任务');await expect(back.locator('svg')).toHaveCount(1);
  await expect.poll(async()=>(await back.boundingBox())?.height||0).toBeGreaterThanOrEqual(40);
  const box=await back.boundingBox();expect(box!.width).toBeGreaterThan(90);
  await expect(page.locator('#workspaceToolbar')).toBeHidden();
  await expect(back).toHaveCSS('font-size','13px');await noOverflow(page);
  await page.locator('.recovery-issue-row').click();await expect(back).toBeVisible();
  await page.screenshot({path:info.outputPath('recovery-polished.png'),fullPage:false});
  await back.click();await expect(modal).toBeHidden();await expect(page).toHaveURL(/page=tasks/);
  await expect(page.locator('#queueBoard')).toBeVisible();
});

test('account menu stays within the viewport and supports keyboard return without invoking an action',async({page},info)=>{
  if(info.project.name==='desktop')await page.setViewportSize({width:952,height:764});
  await boot(page);await navigate(page,'账号');
  const summary=page.locator('.user-actions .workspace-more > summary');
  await summary.press('ArrowDown');
  const menu=page.locator('.user-actions .workspace-more-list');
  await expect(menu.locator('button').first()).toBeFocused();
  await expect.poll(async()=>{const r=await menu.boundingBox(),height=await page.evaluate(()=>innerHeight);return Boolean(r&&r.y>=0&&r.y+r.height<=height);}).toBe(true);
  await menu.locator('button').first().press('End');await expect(menu.locator('button').last()).toBeFocused();
  await expect(menu.locator('button').last()).toHaveCSS('color','rgb(185, 71, 71)');
  await page.screenshot({path:info.outputPath('account-menu-polished.png'),animations:'disabled'});
  await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(summary).toBeFocused();
  await expect(summary).toHaveCSS('outline-style','none');
  expect(await summary.evaluate(node=>getComputedStyle(node).boxShadow)).toContain('inset');
  await expect(page.locator('#confirmActionModal')).toBeHidden();await noOverflow(page);
});

test('healthy empty overview uses a success state without a warning icon or redundant action',async({page},info)=>{
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true,queueBoardMode:'empty',recoveryIssueEmpty:true}});
  await boot(page);const attention=page.locator('.workspace-attention');
  await expect(attention).toHaveAttribute('data-state','clear');
  await expect(attention.locator('.workspace-attention-icon')).toHaveText('✓');
  await expect(attention.locator('button')).toBeHidden();
  await expect(page.locator('#workspaceRunning')).toHaveText('0');await expect(page.locator('#workspaceWaiting')).toHaveText('0');
  await page.screenshot({path:info.outputPath('overview-clear.png'),fullPage:true,animations:'disabled'});
});

test('overview distinguishes subscription loading failure and recovery from an empty list',async({page},info)=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/up-subscriptions',async route=>{await gate;await route.fulfill({status:503,json:{success:false,message:'隔离订阅读取失败'}});});
  await page.goto('/?page=overview');await expect(page.locator('#workspaceSubscriptions')).toHaveText('—');
  await expect(page.locator('#workspaceSubscriptionHint')).toHaveText('正在读取订阅');
  release();await expect(page.locator('#workspaceSubscriptionHint')).toHaveText('订阅读取失败');
  await expect(page.locator('#workspaceSubscriptions')).toHaveText('—');
  await expect(page.locator('#workspaceRecentSubscriptions')).toContainText('暂时无法读取订阅');
  await page.screenshot({path:info.outputPath('overview-subscription-error.png'),fullPage:true,animations:'disabled'});
  await page.unroute('**/api/up-subscriptions');await navigate(page,'UP 订阅');await page.locator('#upRefreshBtn').click();
  await expect(page.locator('#upHomeList .up-subscription-card')).toHaveCount(3);
  await navigate(page,'概览');await expect(page.locator('#workspaceSubscriptions')).toHaveText('3');
  await expect(page.locator('#workspaceSubscriptionHint')).toContainText('2 个持续订阅');
});

test('overview sync reflects the original busy state and sends one request',async({page},info)=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let requests=0;
  await page.route('**/api/sync/now',async route=>{requests++;await gate;await route.fulfill({status:200,json:{success:true,data:{queued:true}}});});
  await boot(page);const button=page.locator('.workspace-heading-actions [data-workspace-action=sync]');
  await button.click();await expect(button).toBeDisabled();await expect(button).toHaveAttribute('aria-busy','true');
  await expect(button).toHaveText('同步中...');await page.keyboard.press('Enter');
  await expect.poll(()=>requests).toBe(1);await page.screenshot({path:info.outputPath('overview-sync-busy.png'),animations:'disabled'});
  release();await expect(button).toBeEnabled();await expect(button).not.toHaveAttribute('aria-busy','true');
  await expect(button).toHaveText('已排队');
});

test('UP selection disclosure opens smoothly and returns focus after clearing',async({page},info)=>{
  await boot(page);await navigate(page,'UP 订阅');await page.locator('#upHomeList [data-up-manage]').first().click();
  await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  const actions=page.locator('.workspace-selection-actions');await expect(actions).toHaveAttribute('inert','');
  await expect(page.locator('#upIncludeBtn')).toBeHidden();
  await page.locator('#upCatalogList input[data-up-video]').first().check();await expect(actions).not.toHaveAttribute('inert','');
  await expect(page.locator('#upIncludeBtn')).toBeVisible();
  expect(await actions.evaluate(node=>getComputedStyle(node).transitionProperty)).toContain('grid-template-rows');
  await page.screenshot({path:info.outputPath('up-selection-polished.png'),animations:'disabled'});
  await page.locator('#upClearPickedBtn').click();await expect(actions).toHaveAttribute('inert','');
  await expect(page.locator('#upSelectPage')).toBeFocused();await expect(page.locator('#upIncludeBtn')).toBeHidden();await noOverflow(page);
});

test('reduced motion and contextual back controls keep a usable recovery flow',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await boot(page);await navigate(page,'任务');await page.locator('#recoveryIssuesBtn').click();
  await page.locator('.recovery-issue-row').click();
  const localBack=page.locator('#recoveryIssuesBackBtn');
  if(await localBack.isVisible()){
    await expect(localBack.locator('span')).toHaveText('返回列表');await localBack.click();
    await expect(page.locator('.recovery-issues-shell')).not.toHaveClass(/show-detail/);
  }
  const back=page.locator('#closeRecoveryIssuesBtn');await expect(back).toHaveCSS('transition-duration','0s');
  await back.click();await expect(page.locator('#recoveryIssuesModal')).toBeHidden();await expect(page).toHaveURL(/page=tasks/);
});

test('shared dialogs preserve the theme and allow canceling without writes',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await boot(page);await navigate(page,'账号');await page.locator('[data-action=favorites]').click();
  await expect(page.locator('#favoritesModal input[type=checkbox]').first()).toBeVisible();
  await expect(page.locator('#favoritesModal input[type=checkbox]').first()).toHaveCSS('accent-color','rgb(57, 197, 187)');
  await page.screenshot({path:info.outputPath('dialog-favorites.png'),animations:'disabled'});
  await page.locator('#closeFavoritesBtn').click();await expect(page.locator('#favoritesModal')).toBeHidden();
  await navigate(page,'UP 订阅');await page.locator('#upAddBtn').click();await expect(page.locator('#upDiscoverySearchBtn')).toBeEnabled();
  await expect(page.locator('#upAddModal')).toHaveAttribute('aria-modal','true');
  await page.screenshot({path:info.outputPath('dialog-up-add.png'),animations:'disabled'});
  await page.locator('[data-up-close="upAddModal"]').click();await expect(page.locator('#upAddModal')).toBeHidden();
  await navigate(page,'设置');await page.locator('#settingsHelpBtn').click();
  await expect(page.locator('#settingsHelpModal')).toHaveAttribute('aria-modal','true');
  await page.screenshot({path:info.outputPath('dialog-settings-help.png'),animations:'disabled'});
  await page.locator('#closeSettingsHelpBtn').click();await expect(page.locator('#settingsHelpModal')).toBeHidden();
  await page.locator('#versionInfoBtn').click();await expect(page.locator('#updatesModal')).toHaveAttribute('aria-modal','true');
  await page.screenshot({path:info.outputPath('dialog-updates.png'),animations:'disabled'});
  await page.locator('#closeUpdatesBtn').click();await expect(page.locator('#updatesModal')).toBeHidden();
  expect(errors).toEqual([]);await noOverflow(page);
});

test('workspace wording stays natural while cleanup consequences and confirmation remain clear',async({page},info)=>{
  await boot(page);
  await expect(page.locator('.workspace-entry-row h3')).toHaveText('在线内容');
  await expect(page.locator('.workspace-entry-row p')).toContainText('单独归档');
  await page.locator('.workspace-entry-row').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('copy-overview.png'),animations:'disabled'});
  await navigate(page,'UP 订阅');
  await expect(page.locator('#upSubscriptionsSection .up-section-heading p')).toHaveText('按订阅规则归档 UP 投稿。');
  await page.locator('#upAddBtn').click();await expect(page.locator('#upAddTitle')).toHaveText('添加 UP 订阅');
  await page.locator('[data-up-close="upAddModal"]').click();await expect(page.locator('#upAddModal')).toBeHidden();
  await navigate(page,'设置');await category(page,'维护与迁移');
  await page.locator('#cleanupDataBtn').click();
  const cleanup=page.locator('#cleanupDataModal');
  await expect(cleanup.locator('input[value="memory-cache"]')).toBeVisible();
  await expect(cleanup).toContainText('清除页面缓存的收藏夹分页，刷新后会重新获取。');
  await expect(cleanup).toContainText('清除网页任务日志，不影响备份。');
  await expect(cleanup).toContainText('清理后不能再用这些备份恢复旧数据');
  await page.locator('#cleanupHelpBtn').click();
  const help=page.locator('#cleanupHelpModal');
  await expect(help.locator('h2')).toHaveText('清理说明');
  await expect(help).toContainText('清理前，先看看各项目的作用和影响。');
  await expect(help).toContainText('页面缓存：普通项目');
  await expect(help).toContainText('全部临时下载文件：重要项目');
  await expect(help).toContainText('不需要先清理项目数据');
  await expect(page.locator('#closeCleanupHelpBtn')).toHaveText('知道了');
  await page.screenshot({path:info.outputPath('copy-cleanup.png'),animations:'disabled'});
  await page.locator('#closeCleanupHelpBtn').click();await expect(help).toBeHidden();
  await page.locator('#executeCleanupBtn').click();
  await expect(cleanup.locator('.toast-message')).toContainText('请先选择要清理的项目。');
  await cleanup.locator('input[value="temp"]').check();
  await expect(page.locator('#cleanupConfirmHint')).toContainText('请输入 DELETE 确认');
  await page.locator('#cleanupConfirmInput').fill('wrong');await page.locator('#executeCleanupBtn').click();
  await expect(cleanup.locator('.toast-message').last()).toHaveText('确认文字不正确，暂未清理。');
  await cleanup.locator('input[value="temp"]').uncheck();await cleanup.locator('input[value="memory-cache"]').check();
  await page.locator('#executeCleanupBtn').click();
  await expect(cleanup.locator('.toast-message').last()).toHaveText('清理完成。');
  await page.request.post('/__test/cleanup-busy',{data:{busy:true}});await page.locator('#refreshCleanupBtn').click();
  await expect(cleanup.locator('input[value="temp"]')).toBeDisabled();
  await expect(cleanup).toContainText('当前有任务运行，此项暂时不能清理。');
  await page.locator('#closeCleanupDataBtn').click();await expect(cleanup).toBeHidden();
});

async function openAllArchives(page:Page){
  await boot(page);await navigate(page,'归档库');
  await page.locator('#archiveLibraryNav').getByRole('button',{name:/^全部归档/}).click();
  await expect(page.locator('#archiveLibraryGrid .archive-library-card')).toHaveCount(6);
}

test('library shares stable app chrome and restores it after nested dialogs and navigation',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await boot(page);
  const brand=await page.locator('.workspace-app-header h1').boundingBox();
  const firstNav=await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'概览',exact:true}).boundingBox();
  await navigate(page,'归档库');
  const library=page.locator('#archiveLibraryModal');
  await expect(library.locator(':scope > .workspace-app-header')).toBeVisible();
  await expect(page.locator('#versionInfoBtn')).toHaveCount(1);
  await expect(page.locator('#versionInfoBtn')).not.toBeFocused();
  await expect(page.locator('.workspace-app-header')).not.toHaveAttribute('inert','');
  const libraryBrand=await page.locator('.workspace-app-header h1').boundingBox();
  const libraryNav=await library.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'概览',exact:true}).boundingBox();
  expect(libraryBrand!.x).toBeCloseTo(brand!.x,0);expect(libraryBrand!.y).toBeCloseTo(brand!.y,0);
  expect(libraryNav!.x).toBeCloseTo(firstNav!.x,0);expect(libraryNav!.y).toBeCloseTo(firstNav!.y,0);
  await page.screenshot({path:info.outputPath('library-directory.png'),animations:'disabled'});
  await page.locator('#versionInfoBtn').click();await expect(page.locator('#updatesModal')).toHaveAttribute('aria-modal','true');
  await expect(library).toHaveAttribute('inert','');
  await page.locator('#closeUpdatesBtn').click();await expect(page.locator('#updatesModal')).toBeHidden();
  await expect(library).not.toHaveAttribute('inert','');
  await expect(page.locator('.workspace-app-header')).not.toHaveAttribute('inert','');
  await expect(page.locator('#versionInfoBtn')).toBeFocused();
  await navigate(page,'账号');await expect(library).toBeHidden();
  await expect(page.locator('body > header #versionInfoBtn')).toBeVisible();
  await expect(page.locator('body > header')).not.toHaveAttribute('inert','');
  expect(errors).toEqual([]);await noOverflow(page);
});

test('nav continuity remains stable during overview and library transitions',async({page},info)=>{
  await boot(page);await navigate(page,'设置');
  async function dimensions(){return page.evaluate(()=>{
    const library=document.querySelector<HTMLElement>('#archiveLibraryModal.active');
    const rail=library?.querySelector<HTMLElement>('.workspace-rail')||document.querySelector<HTMLElement>('body > main .workspace-rail');
    const nav=rail!.querySelector<HTMLElement>('nav button')!.getBoundingClientRect();
    const header=document.querySelector<HTMLElement>('.workspace-app-header')!.getBoundingClientRect();
    return {x:nav.x,y:nav.y,width:nav.width,headerX:header.x,headerWidth:header.width,bodyWidth:document.body.getBoundingClientRect().width,opacity:library?Number(getComputedStyle(library).opacity):1};
  });}
  const baseline=await dimensions();
  for(const destination of ['概览','归档库','设置']){
    const during=page.evaluate(()=>new Promise<Array<{x:number;y:number;width:number;headerX:number;headerWidth:number;bodyWidth:number;opacity:number}>>(resolve=>{
      const started=performance.now(),frames:Array<{x:number;y:number;width:number;headerX:number;headerWidth:number;bodyWidth:number;opacity:number}>=[];
      function sample(){
        const library=document.querySelector<HTMLElement>('#archiveLibraryModal.active');
        const rail=library?.querySelector<HTMLElement>('.workspace-rail')||document.querySelector<HTMLElement>('body > main .workspace-rail');
        const nav=rail?.querySelector<HTMLElement>('nav button')?.getBoundingClientRect();
        const header=document.querySelector<HTMLElement>('.workspace-app-header')?.getBoundingClientRect();
        if(nav&&header)frames.push({x:nav.x,y:nav.y,width:nav.width,headerX:header.x,headerWidth:header.width,bodyWidth:document.body.getBoundingClientRect().width,opacity:library?Number(getComputedStyle(library).opacity):1});
        if(performance.now()-started<450)requestAnimationFrame(sample);else resolve(frames);
      }requestAnimationFrame(sample);
    }));
    await navigate(page,destination);
    const frames=await during;expect(frames.length).toBeGreaterThan(2);
    for(const frame of frames){
      for(const key of ['x','y','width','headerX','headerWidth','bodyWidth'] as const)expect(Math.abs(frame[key]-baseline[key])).toBeLessThan(1);
      expect(frame.opacity).toBeGreaterThan(.99);
    }
    await noOverflow(page);
  }
  if(info.project.name==='desktop'){
    for(const width of [768,952,1900]){
      if(width!==768)await navigate(page,'设置');
      await page.setViewportSize({width,height:900});
      const before=await dimensions();await navigate(page,'归档库');const after=await dimensions();
      expect(Math.abs(before.x-after.x)).toBeLessThan(1);
      expect(Math.abs(before.headerWidth-after.headerWidth)).toBeLessThan(1);
      if(width===952)await page.screenshot({path:info.outputPath('navigation-continuity.png'),animations:'disabled'});
    }
  }
});

test('library controls retain filtering sorting shared-source review and contextual returns',async({page},info)=>{
  if(info.project.name==='desktop')await page.setViewportSize({width:952,height:764});
  const writes:string[]=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(request.method()==='POST'&&!/\/actions\/(context|workspace)$/.test(path))writes.push(path);});
  await openAllArchives(page);
  const search=page.locator('#archiveLibrarySearchInput');
  await expect(search).toHaveCSS('border-radius','12px');await expect(search).toHaveCSS('font-size','14px');
  await expect(page.locator('.archive-library-title').first()).toHaveCSS('color','rgb(26, 47, 45)');
  await search.focus();expect(await search.evaluate(node=>getComputedStyle(node).boxShadow)).toContain('inset');
  await search.fill('独立副本');await expect(page.locator('.archive-library-card')).toHaveCount(1);
  await page.locator('#archiveLibrarySort').selectOption('title_asc');await expect(page.locator('.archive-library-card')).toHaveCount(1);
  await page.locator('#archiveLibrarySearchClearBtn').click();await expect(page.locator('.archive-library-card')).toHaveCount(6);
  await page.locator('#archiveLibraryFilterbar [data-archive-filter=deleted]').click();
  await expect(page.locator('.archive-library-card')).toHaveCount(0);await expect(page.locator('.archive-library-empty')).toBeVisible();
  await page.screenshot({path:info.outputPath('library-empty.png'),animations:'disabled'});
  await page.locator('#archiveLibraryFilterbar [data-archive-filter=all]').click();await expect(page.locator('.archive-library-card')).toHaveCount(6);
  expect(await page.locator('.archive-library-shell').evaluate(node=>node.scrollTop)).toBe(0);
  const titleBox=await page.locator('#archiveLibraryTitle').boundingBox(),shellBox=await page.locator('.archive-library-shell').boundingBox();
  expect(titleBox!.y).toBeGreaterThanOrEqual(shellBox!.y);
  if(info.project.name==='mobile')expect(await page.locator('#archiveLibraryFilterbar').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('library-content.png'),animations:'disabled'});
  const shared=page.locator('[data-archive-bvid="BVUP163637592X001"]');
  await shared.locator('.archive-library-card-more').click();
  await expect(page.locator('#archiveLibraryDetail .archive-library-source')).toHaveCount(3);
  await expect(page.locator('#archiveLibraryDetail .archive-library-source-actions button').first()).toHaveCSS('border-radius','12px');
  if(info.project.name==='mobile-landscape'){
    const cover=await page.locator('#archiveLibraryDetailBody>.archive-library-cover').boundingBox();
    const meta=await page.locator('.archive-library-detail-meta').boundingBox();
    expect(cover!.height).toBeLessThanOrEqual(70);
    expect(meta!.y+meta!.height).toBeLessThanOrEqual(shellBox!.y+shellBox!.height);
  }
  await page.screenshot({path:info.outputPath('library-detail.png'),animations:'disabled'});
  await page.locator('#archiveLibraryDetail').getByRole('button',{name:'管理归档',exact:true}).first().click();
  await expect(page.locator('#upActionModal')).toHaveAttribute('aria-modal','true');
  await expect(page.locator('#upActionModal')).toContainText('影响范围');
  await page.locator('[data-archive-action-close]').click();await expect(page.locator('#upActionModal')).toBeHidden();
  await expect(page.locator('#archiveLibraryModal')).toHaveAttribute('aria-modal','true');
  await expect(page.locator('.workspace-app-header')).not.toHaveAttribute('inert','');
  expect(await page.locator('#archiveLibraryDetailCloseBtn').evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
  await page.locator('#archiveLibraryDetailCloseBtn').click();
  await expect(page.locator('#archiveLibraryDetail')).not.toHaveClass(/open/);
  const back=page.locator('#archiveLibraryMobileBackBtn');if(await back.isVisible())await back.click();
  await page.locator('#archiveLibraryNav').getByRole('button',{name:/^影视飓风/}).click();
  await expect(page.locator('#archiveLibraryTitle')).toContainText('影视飓风');
  await expect(page.locator('.archive-library-card')).toHaveCount(3);
  if(info.project.name==='desktop'){
    await page.setViewportSize({width:768,height:900});
    expect(await page.locator('#archiveLibraryModal .archive-library-toolbar').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('library-tablet.png'),animations:'disabled'});
    await page.setViewportSize({width:1280,height:900});
    await page.locator('#archiveLibraryNav').getByRole('button',{name:/^全部归档/}).click();
    await expect(page.locator('.archive-library-card')).toHaveCount(6);
    await page.screenshot({path:info.outputPath('library-desktop.png'),animations:'disabled'});
  }
  expect(writes).toEqual([]);await noOverflow(page);
});

test('library loading and failed reads keep the shared frame and recover without a false empty page',async({page},info)=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let fail=true;
  await page.route('**/api/archive-library/items?*',async route=>{
    if(fail){await gate;await route.fulfill({status:503,json:{success:false,message:'隔离归档读取失败'}});}else await route.continue();
  });
  await boot(page);await navigate(page,'归档库');
  await page.locator('#archiveLibraryNav').getByRole('button',{name:/^全部归档/}).click();
  await expect(page.locator('#archiveLibraryResults')).toHaveAttribute('aria-busy','true');
  await expect(page.locator('#archiveLibraryResults .archive-library-empty')).toHaveCount(0);
  release();await expect(page.locator('#archiveLibraryNotice')).toContainText('归档列表加载失败');
  await expect(page.locator('#archiveLibraryNotice')).toHaveAttribute('data-state','error');
  await page.screenshot({path:info.outputPath('library-failed.png'),animations:'disabled'});
  fail=false;await page.locator('#archiveLibraryNotice').getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.locator('#archiveLibraryGrid .archive-library-card')).toHaveCount(6);
  await expect(page.locator('#archiveLibraryNotice')).toBeHidden();
  await expect(page.locator('#versionInfoBtn')).toBeVisible();await noOverflow(page);
});
