import { test, expect } from '@playwright/test';

test('unavailable filters ignore late pages and retain each filter cache',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let missing=0;let uploaded=0;
  await page.route('**/api/users/*/unavailable?**',async route=>{
    const filter=new URL(route.request().url()).searchParams.get('filter');
    if(filter==='missing') {missing++;if(missing===1)await new Promise(resolve=>setTimeout(resolve,500));}
    else uploaded++;
    return route.fulfill({json:{success:true,data:{items:[{bvid:'BV'+filter,title:filter+' fixture',mediaId:1}],hasMore:false,nextCursor:null}}});
  });
  await page.goto('/');await page.locator('[data-action="unavailable"]').click();await expect.poll(()=>missing).toBe(1);
  await page.locator('#filterUploadedBtn').click();await expect(page.locator('#unavailableGrid')).toContainText('uploaded fixture');
  await page.waitForTimeout(600);await expect(page.locator('#unavailableGrid')).not.toContainText('missing fixture');
  await page.locator('#filterMissingBtn').click();await expect(page.locator('#unavailableGrid')).toContainText('missing fixture');
  await page.locator('#filterUploadedBtn').click();await expect(page.locator('#unavailableGrid')).toContainText('uploaded fixture');
  expect(uploaded).toBe(1);expect(missing).toBe(2);
});

test('unavailable request failure is retryable and close invalidates old results',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let requests=0;
  await page.route('**/api/users/*/unavailable?**',async route=>{
    const current=++requests;
    if(current===1)return route.fulfill({status:503,json:{success:false,message:'fixture unavailable'}});
    if(current===2)await new Promise(resolve=>setTimeout(resolve,550));
    return route.fulfill({json:{success:true,data:{items:[{bvid:'BV'+current,title:'request '+current}],hasMore:false}}});
  });
  await page.goto('/');await page.locator('[data-action="unavailable"]').click();
  await expect(page.locator('#unavailableGrid')).toContainText('fixture unavailable');
  await page.locator('#unavailableGrid .retry-button').click();await expect.poll(()=>requests).toBe(2);
  await page.locator('#closeUnavailableBtn').click();await page.locator('[data-action="unavailable"]').click();
  await expect(page.locator('#unavailableGrid')).toContainText('request 3');await page.waitForTimeout(650);
  await expect(page.locator('#unavailableGrid')).not.toContainText('request 2');
});
