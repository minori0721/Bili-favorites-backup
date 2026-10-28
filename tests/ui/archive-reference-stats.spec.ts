import {test,expect,type Page,type TestInfo} from '@playwright/test';
import {revealControl} from './workspace-navigation.js';

async function openLibrary(page:Page,info:TestInfo) {
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({status:200,contentType:'text/css',body:''}));
  await page.goto('/?page=library');
  await expect(page.locator('.archive-library-card')).toHaveCount(2);
  if(info.project.name!=='desktop')await (await revealControl(page,page.locator('.archive-nav-item[data-archive-scope="global"]'))).click();
  await expect(page.locator('#archiveLibraryStats')).toBeVisible();
}
const statsBody=(page:Page)=>page.locator('#archiveLibraryStatsBody');
const count=(page:Page)=>statsBody(page).locator('dt:has-text("来源文件引用") + dd');
const openStats=async(page:Page)=>{await (await revealControl(page,page.locator('#archiveLibraryStats > summary'))).click();};

test('statistics load only on expansion and stay independent of search and viewport',async({page},info)=>{
  let requests=0;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/archive-library/reference-stats?*',async route=>{requests++;await route.continue();});
  await openLibrary(page,info);expect(requests).toBe(0);
  await openStats(page);await expect(count(page)).toHaveText('4');expect(requests).toBe(1);
  const box=await statsBody(page).boundingBox(),viewport=page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width+1);
  expect(box!.y+box!.height).toBeLessThanOrEqual(viewport.height+1);
  await page.keyboard.press('Escape');await expect(page.locator('#archiveLibraryStats > summary')).toBeFocused();
  await page.locator('#archiveLibrarySearchInput').fill('Alpha');await expect(page.locator('.archive-library-card')).toHaveCount(1);
  await openStats(page);await expect(count(page)).toHaveText('4');expect(requests).toBe(1);expect(errors).toEqual([]);
});

test('closing an in-flight statistic cancels it and reopening accepts real zero instead of a late response',async({page},info)=>{
  let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/archive-library/reference-stats?*',async route=>{
    calls++;if(calls===1){await gate;await route.fulfill({json:{success:true,data:{sourceReferenceCount:99,uniqueRemotePathCount:99}}}).catch(()=>{});}
    else await route.fulfill({json:{success:true,data:{sourceReferenceCount:0,uniqueRemotePathCount:0}}});
  });
  await openLibrary(page,info);await openStats(page);
  await expect(statsBody(page)).toContainText('正在计算文件统计');await expect(count(page)).toHaveCount(0);
  await expect.poll(()=>calls).toBe(1);await page.keyboard.press('Escape');
  await expect(page.locator('#archiveLibraryStats')).not.toHaveAttribute('open');
  await openStats(page);await expect(count(page)).toHaveText('0');release();
  await expect.poll(()=>calls).toBe(2);await expect(count(page)).toHaveText('0');
});

test('invalid statistics show a retryable error without inventing zero or preventing library use',async({page},info)=>{
  let calls=0;
  await page.route('**/api/archive-library/reference-stats?*',async route=>{
    calls++;await route.fulfill({json:{success:true,data:calls===1?{sourceReferenceCount:4}:{sourceReferenceCount:4,uniqueRemotePathCount:3}}});
  });
  await openLibrary(page,info);await openStats(page);
  await expect(statsBody(page).getByRole('alert')).toContainText('文件统计读取失败');await expect(count(page)).toHaveCount(0);
  await statsBody(page).getByRole('button',{name:'重试文件统计'}).click();
  await expect(count(page)).toHaveText('4');expect(calls).toBe(2);
  await expect(page.locator('#archiveLibraryStats > summary')).toBeFocused();
  await expect(page.locator('.archive-library-card')).toHaveCount(2);
});

test('changing directories discards pending counts from the previous source',async({page},info)=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let pending=0;
  await page.route('**/api/archive-library/reference-stats?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('scope')==='global') {
      pending++;await gate;await route.fulfill({json:{success:true,data:{sourceReferenceCount:99,uniqueRemotePathCount:99}}}).catch(()=>{});
    }else await route.fulfill({json:{success:true,data:{sourceReferenceCount:8,uniqueRemotePathCount:5}}});
  });
  await openLibrary(page,info);await openStats(page);await expect.poll(()=>pending).toBe(1);
  await page.keyboard.press('Escape');
  if(info.project.name!=='desktop')await page.locator('#archiveLibraryMobileBackBtn').click();
  await (await revealControl(page,page.locator('.archive-nav-item[data-archive-media-id="101"]'))).click();
  await openStats(page);await expect(count(page)).toHaveText('8');release();await expect(count(page)).toHaveText('8');
});
