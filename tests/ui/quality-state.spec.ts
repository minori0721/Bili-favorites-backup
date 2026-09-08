import { test, expect } from '@playwright/test';

test('quality batches preserve accepted results when a later batch fails', async ({page}) => {
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  const candidates=Array.from({length:51},(_,index)=>({key:'key-'+index,bvid:'BV'+index,title:'fixture '+index,oldFiles:[]}));
  let batches: {items:{key:string;forceUnknown:boolean}[]}[]=[];
  await page.route('**/api/quality-upgrade**', async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/state'))return route.fulfill({json:{success:true,data:{running:[],completed:[]}}});
    if(path.endsWith('/preview'))return route.fulfill({json:{success:true,data:{candidates,uncertain:[{key:'unknown',oldFiles:[]}],skipped:[],target:{}}}});
    batches.push(route.request().postDataJSON());
    if(batches.length===1)return route.fulfill({json:{success:true,data:{queued:candidates.slice(0,50).map(item=>({...item,artifactKey:'shared'})),skipped:[],downloadGroups:1}}});
    return route.fulfill({status:503,json:{success:false,message:'fixture unavailable'}});
  });
  await page.goto('/');await page.locator('#qualityUpgradeBtn').click();
  await page.locator('#qualityUpgradeSelectAllBtn').click();
  await expect(page.locator('[data-quality-unknown="1"]')).not.toBeChecked();
  await page.locator('#executeQualityUpgradeBtn').click();await page.locator('#confirmActionOkBtn').click();
  await expect(page.locator('#qualityUpgradeResultBlock')).toContainText('已提交：50 个目标');
  await expect(page.locator('#qualityUpgradeResultBlock')).toContainText('fixture unavailable');
  await expect(page.locator('#qualityUpgradeResultBlock')).toContainText('后续批次已停止');
  expect(batches.map(batch=>batch.items.length)).toEqual([50,1]);
  expect(batches.flatMap(batch=>batch.items).every(item=>!item.forceUnknown)).toBe(true);
  await expect(page.locator('#executeQualityUpgradeBtn')).toBeDisabled();
});

test('closing quality maintenance stops subsequent batches', async ({page}) => {
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let batches=0;
  const candidates=Array.from({length:51},(_,index)=>({key:'key-'+index,oldFiles:[]}));
  await page.route('**/api/quality-upgrade**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/state'))return route.fulfill({json:{success:true,data:{running:[],completed:[]}}});
    if(path.endsWith('/preview'))return route.fulfill({json:{success:true,data:{candidates}}});
    batches++;await new Promise(resolve=>setTimeout(resolve,600));
    await route.fulfill({json:{success:true,data:{queued:[],skipped:[],downloadGroups:0}}});
  });
  await page.goto('/');await page.locator('#qualityUpgradeBtn').click();await page.locator('#qualityUpgradeSelectAllBtn').click();
  await page.locator('#executeQualityUpgradeBtn').click();await page.locator('#confirmActionOkBtn').click();
  await expect.poll(()=>batches).toBe(1);await page.locator('#closeQualityUpgradeBtn').click();
  await page.waitForTimeout(700);expect(batches).toBe(1);
  await page.locator('#qualityUpgradeBtn').click();await expect(page.locator('#qualityUpgradeResultBlock')).toBeHidden();
});
