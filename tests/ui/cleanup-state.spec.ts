import {revealControl} from './workspace-navigation.js';
import { test,expect } from '@playwright/test';

test('clearing state removes UP directories using the isolated SQLite while leaving account selection alone',async({page})=>{
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  await page.goto('/?page=settings');await (await revealControl(page,page.locator('#cleanupDataBtn'))).click();
  await (await revealControl(page,page.locator('.cleanup-check[value="state"]'))).check();
  await expect(page.locator('#cleanupConfirmHint')).toContainText('先完成远端归档清理');
  await (await revealControl(page,page.locator('#cleanupDataModal').getByLabel('确认文字',{exact:true}))).fill('DELETE');
  await (await revealControl(page,page.locator('#executeCleanupBtn'))).click();
  await expect(page.locator('#cleanupResultBlock')).toContainText('已清理：备份状态');
  const navigation=(await(await page.request.get('/api/archive-library/navigation')).json()).data;
  expect(navigation.upSubscriptions).toHaveLength(0);expect(navigation.summary.total).toBe(0);
  const users=(await(await page.request.get('/api/users')).json()).data;
  expect(users).toHaveLength(1);
});

test('cleanup keeps partial failure evidence and sends one request for repeated clicks',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  let writes=0;
  await page.route('**/api/storage/cleanup',async route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{success:true,data:{runningTransfers:false,activeScheduler:false,items:[
      {key:'logs',label:'日志',important:false,bytes:10},{key:'temp',label:'临时下载',important:true,bytes:50},
    ]}}});
    writes++;
    await new Promise(resolve=>setTimeout(resolve,180));
    await route.fulfill({status:500,json:{success:false,message:'部分项目未完成',data:{results:[
      {label:'日志',ok:true},{label:'临时下载',ok:false,error:'隔离故障'},
    ]}}});
  });
  await page.goto('/?page=settings');
  await (await revealControl(page,page.locator('#cleanupDataBtn'))).click();
  await expect(page.locator('.cleanup-check')).toHaveCount(2);
  await (await revealControl(page,page.locator('.cleanup-check[value="logs"]'))).check();
  await (await revealControl(page,page.locator('.cleanup-check[value="temp"]'))).check();
  await (await revealControl(page,page.locator('#cleanupConfirmInput'))).fill('DELETE');
  await (await revealControl(page,page.locator('#executeCleanupBtn'))).click();
  expect(writes).toBe(0);
  await (await revealControl(page,page.locator('#cleanupConfirmInput'))).fill('DELETE ALL PROJECT DATA');
  await page.locator('#executeCleanupBtn').evaluate(button=>{
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  });
  await expect(page.locator('#cleanupResultBlock')).toContainText('已清理：日志');
  await expect(page.locator('#cleanupResultBlock')).toContainText('失败：临时下载 - 隔离故障');
  expect(writes).toBe(1);
  await expect(page.locator('#executeCleanupBtn')).toBeEnabled();
  await (await revealControl(page,page.locator('#closeCleanupDataBtn'))).click();
  await (await revealControl(page,page.locator('#cleanupDataBtn'))).click();
  await expect(page.locator('.cleanup-check:checked')).toHaveCount(0);
  await expect(page.locator('#cleanupResultBlock')).toBeHidden();
});

test('cleanup protects busy data and ignores a late state response after closing',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  let reads=0;
  await page.route('**/api/storage/cleanup',async route=>{
    const first=++reads===1;
    if(first)await new Promise(resolve=>setTimeout(resolve,650));
    await route.fulfill({json:{success:true,data:{runningTransfers:!first,activeScheduler:false,items:[
      {key:'logs',label:'日志',important:false,bytes:10},{key:'temp',label:'临时下载',important:true,bytes:50},
    ]}}});
  });
  await page.goto('/?page=settings');
  await (await revealControl(page,page.locator('#cleanupDataBtn'))).click();
  await expect.poll(()=>reads).toBe(1);
  await (await revealControl(page,page.locator('#closeCleanupDataBtn'))).click();
  await (await revealControl(page,page.locator('#cleanupDataBtn'))).click();
  await expect(page.locator('.cleanup-check[value="temp"]')).toBeDisabled();
  await page.waitForTimeout(750);
  await expect(page.locator('.cleanup-check[value="temp"]')).toBeDisabled();
  await (await revealControl(page,page.locator('#cleanupSelectAllBtn'))).click();
  await expect(page.locator('.cleanup-check:checked')).toHaveCount(1);
});
