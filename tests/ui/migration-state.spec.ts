import { test,expect } from '@playwright/test';

test('migration imports only the latest successfully previewed file',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  let previews=0;let imports=0;let imported='';
  await page.route('**/api/migration/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/estimate'))return route.fulfill({json:{success:true,data:{mode:'lightweight',files:2,expandedBytes:100}}});
    if(path.endsWith('/import-preview')){
      const current=++previews;
      if(current===1)await new Promise(resolve=>setTimeout(resolve,650));
      return route.fulfill({json:{success:true,data:{manifest:{version:'fixture-'+current,exportedAt:'2026-09-08T00:00:00Z',counts:{users:1}},conflicts:{tempItemCount:current===1?3:0}}}});
    }
    imports++;imported=route.request().postData()||'';
    await route.fulfill({json:{success:true,data:{restored:['config'],backupPath:'fixture-backup'}}});
  });
  await page.goto('/');
  await page.locator('#migrationBtn').click();
  await expect(page.locator('#migrationModal')).toHaveClass(/active/);
  await page.locator('#migrationFileInput').setInputFiles({name:'first.zip',mimeType:'application/zip',buffer:Buffer.from('first fixture')});
  await expect.poll(()=>previews).toBe(1);
  await expect(page.locator('#executeImportBtn')).toBeDisabled();
  await page.locator('#migrationFileInput').setInputFiles({name:'second.zip',mimeType:'application/zip',buffer:Buffer.from('second fixture')});
  await expect(page.locator('#migrationPreviewText')).toContainText('fixture-2');
  await page.waitForTimeout(750);
  await expect(page.locator('#migrationPreviewText')).toContainText('fixture-2');
  await page.locator('#executeImportBtn').click();
  await expect(page.locator('#confirmActionModal')).toHaveClass(/active/);
  expect(imports).toBe(0);
  await page.locator('#confirmActionInput').fill('IMPORT DATA');
  await page.locator('#confirmActionOkBtn').click();
  await expect(page.locator('#migrationStatus')).toContainText('导入完成');
  expect(imports).toBe(1);expect(imported).toBe('second fixture');
});

test('closing migration aborts a slow preview and leaves reopening unselected',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  let previews=0;
  await page.route('**/api/migration/**',async route=>{
    if(route.request().url().endsWith('/estimate'))return route.fulfill({json:{success:true,data:{}}});
    previews++;await new Promise(resolve=>setTimeout(resolve,650));
    await route.fulfill({json:{success:true,data:{manifest:{version:'old',counts:{}},conflicts:{}}}});
  });
  await page.goto('/');await page.locator('#migrationBtn').click();
  await page.locator('#migrationFileInput').setInputFiles({name:'old.zip',mimeType:'application/zip',buffer:Buffer.from('fixture')});
  await expect.poll(()=>previews).toBe(1);
  await page.locator('#closeMigrationBtn').click();await page.locator('#migrationBtn').click();
  await page.waitForTimeout(750);
  await expect(page.locator('#migrationPreviewBlock')).toBeHidden();
  await expect(page.locator('#executeImportBtn')).toBeDisabled();
  await expect(page.locator('#migrationFileInput')).toHaveValue('');
});
