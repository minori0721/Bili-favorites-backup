import { test, expect } from '@playwright/test';

const candidate = (id: string) => ({candidateId:id,bvid:'BVfixture',oldPath:'/old/'+id,newPath:'/new/'+id,oldName:'old-'+id,newName:'new-'+id});
const preview = (id: string, revision=1, scanning=false) => ({previewId:id,revision,expiresAt:Date.now()+60_000,candidates:[candidate('one'),candidate('two')],skipped:[],remoteScan:{status:scanning?'scanning':'ready',complete:true}});

test('rename polling preserves deselection and submits one reviewed preview', async ({page}) => {
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let polls=0; let submissions: unknown[]=[];
  await page.route('**/api/rename**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/preview')) return route.fulfill({json:{success:true,data:preview('current',1,true)}});
    if(url.pathname.endsWith('/status')) { polls++; return route.fulfill({json:{success:true,data:preview('current',2)}}); }
    submissions.push(route.request().postDataJSON());
    await new Promise(resolve=>setTimeout(resolve,300));
    return route.fulfill({json:{success:true,data:{success:1,failed:0,results:[{ok:true,status:'renamed',oldPath:'/old/two',newPath:'/new/two'}]}}});
  });
  await page.goto('/');await page.locator('#renameBtn').click();
  await page.locator('[data-rename-candidate-id="one"]').uncheck();
  await expect.poll(()=>polls).toBe(1);
  await expect(page.locator('[data-rename-candidate-id="one"]')).not.toBeChecked();
  await page.locator('#executeRenameBtn').dblclick();
  await expect(page.locator('#confirmActionMessage')).toContainText('1 个');
  await expect(page.locator('#confirmActionModal')).toHaveClass(/active/);
  expect(submissions).toEqual([]);
  await page.locator('#confirmActionOkBtn').click();
  await expect(page.locator('#renameResultBlock')).toContainText('成功 1 个');
  expect(submissions).toEqual([{previewId:'current',candidateIds:['two']}]);
  await expect(page.locator('#executeRenameBtn')).toBeDisabled();
});

test('rename ignores a late preview after closing and reopening', async ({page}) => {
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let requests=0;
  await page.route('**/api/rename/preview',async route=>{
    const current=++requests;
    if(current===1) await new Promise(resolve=>setTimeout(resolve,700));
    const data=preview('preview-'+current);data.candidates=[candidate('request-'+current)];
    await route.fulfill({json:{success:true,data}});
  });
  await page.goto('/');await page.locator('#renameBtn').click();await expect.poll(()=>requests).toBe(1);
  await page.locator('#closeRenamePreviewBtn').click();await page.locator('#renameBtn').click();
  await expect(page.locator('#renamePreviewList')).toContainText('new-request-2');
  await page.waitForTimeout(800);
  await expect(page.locator('#renamePreviewList')).not.toContainText('request-1');
});
