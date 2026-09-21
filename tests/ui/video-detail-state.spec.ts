import { test, expect } from '@playwright/test';

test('detail filters discard late responses and validate before updating counts',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let all=0;
  await page.route('**/api/users/*/favorites/*/detail-items?**',async route=>{
    const filter=new URL(route.request().url()).searchParams.get('filter');
    if(filter==='all'){all++;await new Promise(resolve=>setTimeout(resolve,500));}
    return route.fulfill({json:{success:true,data:{items:[{bvid:'BV'+filter,title:'fixture '+filter}],page:1,hasMore:false,summary:{total:filter==='all'?99:1,uploaded:1}}}});
  });
  await page.goto('/');await page.locator('[data-action="favorite_detail"]').first().click();await expect.poll(()=>all).toBe(1);
  await page.locator('#vdFilterUploadedBtn').click();await expect(page.locator('#videoGrid')).toContainText('fixture uploaded');await page.waitForTimeout(600);
  await expect(page.locator('#videoGrid')).not.toContainText('fixture all');await expect(page.locator('#vdFilterAllBtn')).toHaveText('全部 (1)');
});

test('closing detail cancels recheck and prevents a late success notice',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  await page.route('**/api/users/*/favorites/*/detail-items?**',route=>route.fulfill({json:{success:true,data:{items:[{bvid:'BVfixture',sourceAvailability:{state:'unknown' as const}}],page:1,hasMore:false}}}));
  let requests=0;
  await page.route('**/api/videos/*/availability-recheck',async route=>{requests++;await new Promise(resolve=>setTimeout(resolve,650));return route.fulfill({json:{success:true,data:{}}});});
  await page.goto('/');await page.locator('[data-action="favorite_detail"]').first().click();
  await page.locator('#videoGrid .video-source-availability button').click();await expect.poll(()=>requests).toBe(1);
  await page.locator('#closeVideoDetailBtn').click();await page.waitForTimeout(750);
  await expect(page.getByText('已加入一次后台复核',{exact:true})).toHaveCount(0);
  await page.locator('[data-action="favorite_detail"]').first().click();await expect(page.locator('#videoGrid .video-source-availability button')).toBeEnabled();
});
