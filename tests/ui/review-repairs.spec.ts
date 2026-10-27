import {revealControl,toggleSetting,navigate} from './workspace-navigation.js';
import {test,expect,type Page} from '@playwright/test';

test.beforeEach(async({page})=>{
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  await page.goto('/?page=settings');await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
});

test('blank zero-valued settings stay dirty and cannot be saved as zero',async({page})=>{
  await (await revealControl(page,page.locator('#delaySeconds'))).fill('');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  let saves=0;page.on('request',request=>{if(request.method()==='PUT'&&request.url().endsWith('/api/config'))saves++;});
  await (await revealControl(page,page.locator('#saveConfigBtn'))).click();await expect(page.locator('#delaySeconds')).toBeFocused();expect(saves).toBe(0);
  await (await revealControl(page,page.locator('#delaySeconds'))).fill('0');await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
});

test('naming edits preserve literal text, separators and repeated variables',async({page})=>{
  await toggleSetting(page,'namingSettings');
  await (await revealControl(page,page.locator('#filenameTemplate'))).fill('前缀_<bvid>__<ownerName>_<bvid>_后缀');
  await expect(page.locator('#selectedTags .template-tag')).toHaveCount(3);
  await (await revealControl(page,page.getByRole('button',{name:'下移BV号',exact:true}).first())).click();
  await expect(page.locator('#filenameTemplate')).toHaveValue('前缀_<ownerName>__<bvid>_<bvid>_后缀');
  await (await revealControl(page,page.getByRole('button',{name:'移除BV号',exact:true}).first())).click();
  await expect(page.locator('#filenameTemplate')).toHaveValue('前缀_<ownerName>___<bvid>_后缀');
  await (await revealControl(page,page.locator('#templateTags').getByRole('button',{name:'清晰度',exact:true}))).click();
  await expect(page.locator('#filenameTemplate')).toHaveValue('前缀_<ownerName>___<bvid>_后缀-<dfn>');
});

test('a late save response acknowledges only the submitted draft',async({page})=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/config',async route=>{if(route.request().method()==='PUT'){await gate;}await route.continue();});
  await (await revealControl(page,page.locator('#pollInterval'))).fill('7');await (await revealControl(page,page.locator('#saveConfigBtn'))).click();
  await expect(page.locator('#saveConfigBtn')).toHaveAttribute('aria-busy','true');
  await (await revealControl(page,page.locator('#pollInterval'))).fill('8');release();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await expect(page.locator('#configStatus')).toContainText('还有新的修改未保存');
  await (await revealControl(page,page.locator('#pollInterval'))).fill('7');await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
});

async function migration(page:Page){await (await revealControl(page,page.locator('#pathMigrationBtn'))).click();await expect(page.locator('#pathMigrationModal')).toBeVisible();}
test('migration without a preview disables every stage action and reveals validation errors',async({page})=>{
  await migration(page);await expect(page.locator('#pathMigrationPreviewBtn')).toBeEnabled();
  for(const action of ['Start','Pause','Resume','Cancel','Cleanup','Keep'])await expect(page.locator('#pathMigration'+action+'Btn')).toBeDisabled();
  await (await revealControl(page,page.locator('#pathMigrationPreviewBtn'))).click();
  await expect(page.locator('#pathMigrationStatus')).toBeVisible();await expect(page.locator('#pathMigrationStatus')).toContainText('请填写新归档路径');
  await expect(page.locator('#pathMigrationDestination')).toBeFocused();
  await (await revealControl(page,page.locator('#pathMigrationDestination'))).fill('/新归档');await (await revealControl(page,page.locator('#pathMigrationPreviewBtn'))).click();
  await expect(page.locator('#pathMigrationStartBtn')).toBeEnabled();await expect(page.locator('#pathMigrationPauseBtn')).toBeDisabled();
});

test('malformed migration responses show a safe error and can be retried',async({page})=>{
  let bad=true;await page.route('**/api/path-migration/state',route=>bad?route.fulfill({status:502,contentType:'text/html',body:'<html>Bad gateway</html>'}):route.continue());
  await migration(page);await expect(page.locator('#pathMigrationStatus')).toContainText('服务器响应异常');
  await expect(page.locator('#pathMigrationStartBtn')).toBeDisabled();await expect(page.locator('#pathMigrationPreviewBtn')).toBeDisabled();
  bad=false;await (await revealControl(page,page.locator('#pathMigrationStatus').getByRole('button',{name:'重试读取'}))).click();
  await expect(page.locator('#pathMigrationPreviewBtn')).toBeEnabled();await expect(page.locator('#pathMigrationSummary')).toContainText('还没有路径预览');
  await expect(page.locator('#pathMigrationStatus')).toBeHidden();
});

test('UP catalog selections survive closing and reopening without submitting',async({page})=>{
  await navigate(page,'subscriptions');
  const trigger=page.locator('#upHomeList .up-subscription-card').filter({hasText:'影视飓风'}).getByRole('button',{name:'投稿选择',exact:true});
  let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/selection'))writes++;});
  await (await revealControl(page,trigger)).click();const checkbox=page.locator('#upCatalogList input[data-up-video]').first();await (await revealControl(page,checkbox)).check();
  await (await revealControl(page,page.locator('[data-up-close="upWorkspaceModal"]'))).click();await expect(page.locator('#upWorkspaceModal')).toBeHidden();
  await (await revealControl(page,trigger)).click();await expect(checkbox).toBeChecked();await expect(page.locator('#upCatalogPicked')).toHaveText('已选 1 个');expect(writes).toBe(0);
  await (await revealControl(page,page.locator('#upClearPickedBtn'))).click();await (await revealControl(page,page.locator('[data-up-close="upWorkspaceModal"]'))).click();await expect(page.locator('#upWorkspaceModal')).toBeHidden();
  await (await revealControl(page,trigger)).click();await expect(checkbox).not.toBeChecked();
  await (await revealControl(page,checkbox)).check();await (await revealControl(page,page.locator('[data-up-close="upWorkspaceModal"]'))).click();await expect(page.locator('#upWorkspaceModal')).toBeHidden();
  await (await revealControl(page,trigger)).click();await (await revealControl(page,checkbox)).uncheck();
  expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(false);
});
