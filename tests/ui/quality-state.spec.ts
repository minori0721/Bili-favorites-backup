import { test, expect } from '@playwright/test';
import { createQualityMaintenance } from '../../src/scheduler/quality-maintenance.js';
import { testConfig } from '../helpers.js';

test('quality preview shows real before and target details while unknown items still require explicit selection', async ({page},testInfo) => {
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  const preview=createQualityMaintenance({
    config:()=>testConfig({alistDest:'/archive',bbdownQuality:'1080P',bbdownEncoding:'HEVC'}),targetKeys:()=>new Set(),
    records:()=>[{
      bvid:'BVquality',title:'画质对照',upperName:'测试UP',remoteFiles:[],relations:[
        {userId:'user',mediaId:1,folderTitle:'已知画质',backupStatus:'verified',hasInterruptedQualityUpgrade:false,remotePath:'/archive/known',remoteFiles:[{
          name:'known.mp4',path:'/archive/known/known.mp4',qualityProfile:{quality:'720P',encoding:'AVC',hiRes:false,dolby:false},
          mediaMetadata:{width:1280,height:720,codec:'h264',source:'ffprobe',observedAt:'2026-10-19T00:00:00Z'},
        }]},
        {userId:'user',mediaId:2,folderTitle:'部分资料缺失',backupStatus:'verified',hasInterruptedQualityUpgrade:false,remotePath:'/archive/unknown',remoteFiles:[{
          name:'unknown.mp4',path:'/archive/unknown/unknown.mp4',filenameMetadata:{bilibiliQuality:'1080P 高码率',videoCodecs:'h264'},
        }]},
      ],
    }],users:{getById:()=>null},enqueue:()=>{throw new Error('Read-only quality preview');},
  }).preview();
  await page.route('**/api/quality-upgrade**',route=>route.fulfill({json:{success:true,data:new URL(route.request().url()).pathname.endsWith('/preview')?preview:{running:[],completed:[]}}}));
  let probeStarts=0;
  await page.route('**/api/media-probe',route=>{
    probeStarts++;expect(route.request().postDataJSON()).toEqual({userId:'user',bvid:'BVquality',reuse:true});
    return route.fulfill({status:202,json:{success:true,data:{probeId:'quality-probe'}}});
  });
  await page.route('**/api/media-probe/*',route=>route.fulfill({json:{success:true,data:{bvid:'BVquality',status:'complete',pages:[{pageIndex:1,tracks:[
    {quality:'1080P',encoding:'HEVC',available:true},{quality:'4K',encoding:'HEVC',available:true},
  ]}],combinations:[]}}}));
  await page.goto('/');await page.locator('#qualityUpgradeBtn').click();
  const rows=page.locator('#qualityUpgradeList .rename-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('现有：720P / AVC → 目标：1080P / HEVC');
  await expect(rows.nth(1)).toContainText('现有：1080P+ / AVC → 目标：1080P / HEVC');
  await expect(rows.nth(1)).toContainText('旧画质档案不完整，需要人工确认；勾选即表示仍要强制重新下载。');
  await expect(page.locator('#qualityUpgradeList')).not.toContainText('按当前 BBDown 画质设置重新下载');
  await page.locator('#qualityUpgradeSelectAllBtn').click();
  await expect(rows.nth(0).locator('input')).toBeChecked();
  await expect(rows.nth(1).locator('input')).not.toBeChecked();
  await rows.nth(0).locator('[data-quality-probe-key]').scrollIntoViewIfNeeded();
  await expect(rows.nth(0)).toContainText('当前账号可获取最高：4K / HEVC；本次预计下载：1080P / HEVC');
  await expect(rows.nth(1)).toContainText('当前账号可获取最高：4K / HEVC；本次预计下载：1080P / HEVC');
  expect(probeStarts).toBe(1);
  const modal=page.locator('#qualityUpgradeModal');
  expect(await modal.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  await modal.screenshot({path:testInfo.outputPath('quality-before-target.png')});
});

test('quality preview probes visible items serially and closing drops the remaining work',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});await page.clock.install();
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  const starts:string[]=[];
  let firstRead=true;let release:()=>void=()=>{throw new Error('no pending read');};
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/quality-upgrade**',route=>route.fulfill({json:{success:true,data:new URL(route.request().url()).pathname.endsWith('/preview')?
    {candidates:[{key:'a',userId:'user',bvid:'BVfirst',oldFiles:[]},{key:'b',userId:'user',bvid:'BVsecond',oldFiles:[]}],target:{}}:{running:[],completed:[]}}}));
  await page.route('**/api/media-probe',route=>{const body=route.request().postDataJSON();starts.push(body.bvid);return route.fulfill({status:202,json:{success:true,data:{probeId:body.bvid}}});});
  await page.route('**/api/media-probe/*',async route=>{
    if(firstRead){firstRead=false;await pending;}
    await route.fulfill({json:{success:true,data:{bvid:new URL(route.request().url()).pathname.split('/').pop(),status:'complete',pages:[{pageIndex:1,tracks:[{quality:'4K',encoding:'HEVC',available:true}]}],combinations:[]}}});
  });
  await page.goto('/');await page.locator('#qualityUpgradeBtn').click();
  const lines=page.locator('#qualityUpgradeList [data-quality-probe-key]');
  await lines.nth(0).scrollIntoViewIfNeeded();
  await page.locator('#qualityUpgradeSelectAllBtn').click();
  await expect.poll(()=>starts.length).toBe(1);
  await lines.nth(1).scrollIntoViewIfNeeded();
  await expect(lines.nth(1)).toContainText('等待探测');
  await page.clock.runFor(10_000);expect(starts).toHaveLength(1);
  await page.locator('#closeQualityUpgradeBtn').click();await page.clock.runFor(10_000);expect(starts).toHaveLength(1);
  release();
  await page.locator('#qualityUpgradeBtn').click();await page.locator('#qualityUpgradeSelectAllBtn').click();
  await lines.nth(0).scrollIntoViewIfNeeded();
  await expect.poll(()=>starts.length).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#qualityUpgradeList')).toContainText('已探测');
  await lines.nth(1).scrollIntoViewIfNeeded();
  await page.clock.runFor(2_001);await expect.poll(()=>starts.length).toBe(3);
  expect(starts).toEqual(['BVfirst','BVfirst','BVsecond']);
});

test('selecting five thousand quality candidates does not queue offscreen probes and scrolling drops old waiting items',async({page})=>{
  test.setTimeout(60_000);
  await page.request.post('/__test/reset',{data:{}});await page.clock.install();
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  const candidates=Array.from({length:5_000},(_,index)=>({key:'key-'+index,userId:'user',bvid:'BVbulk'+index,oldFiles:[]}));
  const starts:string[]=[];let reads=0;
  let releaseFirst:()=>void=()=>{};let releaseSecond:()=>void=()=>{};
  const firstRead=new Promise<void>(resolve=>{releaseFirst=resolve;});
  const secondRead=new Promise<void>(resolve=>{releaseSecond=resolve;});
  await page.route('**/api/quality-upgrade**',route=>route.fulfill({json:{success:true,data:new URL(route.request().url()).pathname.endsWith('/preview')?
    {candidates,target:{}}:{running:[],completed:[]}}}));
  await page.route('**/api/media-probe',route=>{const body=route.request().postDataJSON();starts.push(body.bvid);return route.fulfill({status:202,json:{success:true,data:{probeId:body.bvid}}});});
  await page.route('**/api/media-probe/*',async route=>{
    reads++;if(reads===1)await firstRead;else if(reads===2)await secondRead;
    await route.fulfill({json:{success:true,data:{bvid:new URL(route.request().url()).pathname.split('/').pop(),status:'complete',pages:[{pageIndex:1,tracks:[{quality:'4K',encoding:'HEVC',available:true}]}],combinations:[]}}});
  });
  await page.goto('/');
  // Keep exactly one probe line in view on every device without replacing the real observer.
  await page.addStyleTag({content:'#qualityUpgradeList .rename-item {min-height:1000px;align-items:flex-start;}'});
  await page.locator('#qualityUpgradeBtn').click();
  const lines=page.locator('#qualityUpgradeList [data-quality-probe-key]');
  try {
    await expect(lines).toHaveCount(5_000);await lines.nth(0).scrollIntoViewIfNeeded();
    await expect.poll(()=>starts).toEqual(['BVbulk0']);
    await page.locator('#qualityUpgradeSelectAllBtn').click();
    await expect(page.locator('#qualityUpgradeList input:checked')).toHaveCount(5_000);
    await page.locator('#qualityUpgradeList input[type="checkbox"]').nth(2_500).evaluate((input:HTMLInputElement)=>{
      input.checked=false;input.dispatchEvent(new Event('change'));
      input.checked=true;input.dispatchEvent(new Event('change'));
    });
    releaseFirst();await expect(lines.nth(0)).toContainText('已探测');
    await page.clock.runFor(20_001);expect(starts).toEqual(['BVbulk0']);
    await lines.nth(1).scrollIntoViewIfNeeded();await expect.poll(()=>starts).toEqual(['BVbulk0','BVbulk1']);
    await lines.nth(2).scrollIntoViewIfNeeded();await expect(lines.nth(2)).toContainText('等待探测');
    await lines.nth(4_999).scrollIntoViewIfNeeded();await expect(lines.nth(4_999)).toContainText('等待探测');
    await expect(lines.nth(2).locator('span')).toHaveText('滚动查看时探测最高画质');
    releaseSecond();await expect(lines.nth(1)).toContainText('已探测');
    await page.clock.runFor(2_001);await expect.poll(()=>starts).toEqual(['BVbulk0','BVbulk1','BVbulk4999']);
    await expect(lines.nth(4_999)).toContainText('已探测');
    await page.clock.runFor(20_001);expect(starts).toEqual(['BVbulk0','BVbulk1','BVbulk4999']);
    await expect(page.locator('#qualityUpgradeList input:checked')).toHaveCount(5_000);
  } finally {releaseFirst();releaseSecond();}
});

test('quality submission does not wait for the pending preview probe',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  const candidates=[{key:'one',userId:'user',bvid:'BVone',oldFiles:[]},{key:'two',userId:'user',bvid:'BVtwo',oldFiles:[]}];
  let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;});let reads=0;
  let submitted:unknown;
  await page.route('**/api/quality-upgrade**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/preview'))return route.fulfill({json:{success:true,data:{candidates,target:{}}}});
    if(path.endsWith('/state'))return route.fulfill({json:{success:true,data:{running:[],completed:[]}}});
    submitted=route.request().postDataJSON();
    return route.fulfill({json:{success:true,data:{queued:candidates,skipped:[],downloadGroups:2}}});
  });
  await page.route('**/api/media-probe',route=>route.fulfill({status:202,json:{success:true,data:{probeId:'pending'}}}));
  await page.route('**/api/media-probe/*',async route=>{
    reads++;await pending;await route.fulfill({json:{success:true,data:{bvid:'BVone',status:'failed',error:'late preview'}}});
  });
  await page.goto('/');await page.locator('#qualityUpgradeBtn').click();
  try {
    await page.locator('#qualityUpgradeList [data-quality-probe-key]').first().scrollIntoViewIfNeeded();
    await expect.poll(()=>reads).toBe(1);await page.locator('#qualityUpgradeSelectAllBtn').click();
    await page.locator('#executeQualityUpgradeBtn').click();await page.locator('#confirmActionOkBtn').click();
    await expect(page.locator('#qualityUpgradeResultBlock')).toContainText('已提交：2 个目标');
    expect(submitted).toEqual({items:[{key:'one',forceUnknown:false},{key:'two',forceUnknown:false}]});
    release();await expect(page.locator('#qualityUpgradeResultBlock')).not.toContainText('late preview');
  } finally {release();}
});

test('quality preview does not start Bili probes while the page is hidden',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});await page.clock.install();
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let starts=0;
  await page.route('**/api/quality-upgrade**',route=>route.fulfill({json:{success:true,data:new URL(route.request().url()).pathname.endsWith('/preview')?
    {candidates:[{key:'one',userId:'user',bvid:'BVone',oldFiles:[]}],target:{}}:{running:[],completed:[]}}}));
  await page.route('**/api/media-probe',route=>{starts++;return route.fulfill({status:202,json:{success:true,data:{probeId:'one'}}});});
  await page.route('**/api/media-probe/*',route=>route.fulfill({json:{success:true,data:{bvid:'BVone',status:'complete',pages:[{pageIndex:1,tracks:[{quality:'4K',encoding:'HEVC',available:true}]}],combinations:[]}}}));
  await page.goto('/');
  await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
  await page.locator('#qualityUpgradeBtn').click();await page.locator('#qualityUpgradeSelectAllBtn').click();
  await page.locator('#qualityUpgradeList [data-quality-probe-key]').scrollIntoViewIfNeeded();
  await expect(page.locator('#qualityUpgradeList [data-quality-probe-key]')).toContainText('等待探测');
  await page.clock.runFor(10_000);expect(starts).toBe(0);
  await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:false}));
  await page.clock.runFor(1_001);await expect.poll(()=>starts).toBe(1);
  await expect(page.locator('#qualityUpgradeList')).toContainText('当前账号可获取最高：4K');
});

test('quality preview keeps failed or late probe results separate from a reopened preview',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let starts=0;let finish:()=>void=()=>{throw new Error('no pending probe');};
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  await page.route('**/api/quality-upgrade**',route=>route.fulfill({json:{success:true,data:new URL(route.request().url()).pathname.endsWith('/preview')?
    {candidates:[{key:'one',userId:'user',bvid:'BVone',oldFiles:[]}],target:{}}:{running:[],completed:[]}}}));
  await page.route('**/api/media-probe',route=>route.fulfill({status:202,json:{success:true,data:{probeId:'probe'+(++starts)}}}));
  await page.route('**/api/media-probe/*',async route=>{
    if(route.request().url().endsWith('probe1'))await pending;
    await route.fulfill({json:{success:true,data:{bvid:'BVone',status:'failed',error:route.request().url().endsWith('probe1')?'old result':'test timeout'}}});
  });
  await page.goto('/');await page.locator('#qualityUpgradeBtn').click();
  await page.locator('#qualityUpgradeList [data-quality-probe-key]').scrollIntoViewIfNeeded();
  await expect.poll(()=>starts).toBe(1);await page.locator('#closeQualityUpgradeBtn').click();
  await page.locator('#qualityUpgradeBtn').click();
  await page.locator('#qualityUpgradeList [data-quality-probe-key]').scrollIntoViewIfNeeded();
  await expect(page.locator('#qualityUpgradeList')).toContainText('最高画质尚未确认：test timeout');
  finish();await expect(page.locator('#qualityUpgradeList')).not.toContainText('old result');
  await page.getByRole('button',{name:'重新探测',exact:true}).click();
  await expect.poll(()=>starts).toBe(3);await expect(page.locator('#qualityUpgradeList')).toContainText('test timeout');
});

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
