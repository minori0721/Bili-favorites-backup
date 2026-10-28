import {expect,test,type Page} from '@playwright/test';

async function openDirectories(page:Page){
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true}});
  await page.goto('/?page=library');
  await expect(page.locator('.archive-nav-up')).toHaveCount(3);
}

test('directory pictures, menu keyboard navigation and inactive cleanup use the real isolated workflow',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openDirectories(page);
  const avatar=page.locator('.archive-nav-up .archive-nav-preview').first();
  await expect(avatar.locator('img')).toBeVisible();
  expect(await avatar.evaluate(node=>getComputedStyle(node).borderRadius)).toBe('50%');
  expect(await page.locator('button button').count()).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const group=page.locator('.archive-nav-inactive').filter({hasText:'已停用归档'});
  await group.locator('summary').click();
  const row=page.locator('.archive-nav-row').filter({has:page.locator('[data-archive-media-id="99"]')});
  const more=row.getByRole('button',{name:'已停用的旧收藏夹的更多操作',exact:true});
  await more.click();
  const menu=page.getByRole('menu');await expect(menu).toBeVisible();
  await page.keyboard.press('End');await expect(menu.getByRole('menuitem',{name:'清理此来源归档'})).toBeFocused();
  await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(more).toBeFocused();
  if(info.project.name!=='desktop'){const size=await more.boundingBox();expect(size!.width).toBeGreaterThanOrEqual(44);expect(size!.height).toBeGreaterThanOrEqual(44);}
  await more.click();await page.getByRole('menuitem',{name:'清理此来源归档'}).click();
  await expect(page.locator('#confirmActionTitle')).toHaveText('清理停用收藏夹的归档');
  await expect(page.locator('#confirmActionDetail')).toContainText('其他来源仍在使用的文件会保留');
  await page.locator('#confirmActionCancelBtn').click();await expect(page.locator('#confirmActionModal')).toBeHidden();await expect(row).toHaveCount(1);
  await more.click();await page.getByRole('menuitem',{name:'清理此来源归档'}).click();
  await expect(page.locator('#confirmActionModal')).toHaveClass(/active/);
  await page.locator('#confirmActionInput').fill('DELETE ARCHIVE');await page.locator('#confirmActionOkBtn').click();
  await expect(row).toHaveCount(0,{timeout:12000});
  await expect(page.locator('.archive-nav-item[data-archive-media-id="11"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('failed directory cleanup stays visible with retry and stop actions',async({page})=>{
  await openDirectories(page);
  await page.request.post('/__test/up-deletion-failure',{data:{enabled:true}});
  await page.locator('.archive-nav-inactive').filter({hasText:'已停用归档'}).locator('summary').click();
  const row=page.locator('.archive-nav-row').filter({has:page.locator('[data-archive-media-id="99"]')});
  await row.locator('.archive-nav-more').click();await page.getByRole('menuitem',{name:'清理此来源归档'}).click();
  await page.locator('#confirmActionInput').fill('DELETE ARCHIVE');await page.locator('#confirmActionOkBtn').click();
  await expect(row.locator('.archive-nav-cleanup')).toContainText('失败',{timeout:12000});
  // Navigation is rebuilt from the persisted failure; reopen its disclosure if needed.
  const summary=page.locator('.archive-nav-inactive').filter({hasText:'已停用归档'}).locator('summary');
  if(!await row.locator('.archive-nav-more').isVisible())await summary.click();
  await row.locator('.archive-nav-more').click();await expect(page.getByRole('menuitem',{name:'重试清理',exact:true})).toBeVisible();
  await page.getByRole('menuitem',{name:'停止剩余清理'}).click();await page.locator('#confirmActionInput').fill('STOP ARCHIVE CLEANUP');await page.locator('#confirmActionOkBtn').click();
  await expect(row.locator('.archive-nav-cleanup')).toHaveCount(0);await expect(row).toHaveCount(1);
});
