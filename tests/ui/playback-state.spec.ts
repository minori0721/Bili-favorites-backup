import {revealControl,navigate} from './workspace-navigation.js';
import { expect, test } from '@playwright/test';

// Exercise the application through the vendor and DOM boundaries; no internal app functions are exposed.
const playerAdapter = `window.Artplayer = class {
  constructor(options) {
    this.video = document.createElement('video');
    this.video.dataset.url = options.url;
    options.container.appendChild(this.video);
    this.template={$player:options.container,$setting:document.createElement('div')};
    this.setting={show:false};this.controls={show:true};
    this.currentTime = 15; this.duration = 120; this.volume = 0.5; this.muted = false; this.playbackRate = 1;
  }
  on(name, callback) { this.video.addEventListener('fixture:' + name, callback); return this; }
  once(name,callback){this.video.addEventListener('fixture:'+name,callback,{once:true});return this;}
  destroy() { this.video.dispatchEvent(new Event('fixture:destroy'));this.video.dataset.destroyed = 'true'; this.video.remove(); }
  play() { return Promise.resolve(); }
  pause() {}
  get currentTime(){return Number(this.video.dataset.position || 0);}
  set currentTime(value){this.video.dataset.position=String(value);}
};`;

test('player falls back once and ignores events from a released instance', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/assets/vendor/artplayer-5.4.0.js', route => route.fulfill({ contentType: 'application/javascript', body: playerAdapter }));
  const items = ['BV1ALPHA001', 'BV1BETA002'].map((bvid, index) => ({
    bvid, title: 'Fixture ' + (index ? 'B' : 'A'), upperName: 'UP', queuePosition: index + 1,
    source: { userId: 'user-1', mediaId: 101 },
    parts: [{ fileId: index + 1, pageIndex: 1, label: '正片', fingerprint: bvid, streamUrl: '/fixture-media/' + bvid, codec: 'avc1' }],
  }));
  await page.route('**/api/archive-library/playback-queue?**', route => route.fulfill({ json: { success: true, data: {
    mode: 'library' as const, page: 1, pageSize: 50, total: 2, focusIndex: 0, hasMore: false, items,
  } } }));
  await page.route('**/playback/delivery/**', route => route.fulfill({ json: { success: true, data: { status: 'direct' as const } } }));
  await page.goto('/?page=accounts');
  await (await revealControl(page,page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'归档库',exact:true}))).click();
  if (info.project.name !== 'desktop') await (await revealControl(page,page.locator('.archive-nav-item[data-archive-scope="global"]'))).click();
  const open = page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main');
  await (await revealControl(page,open)).click();
  const video = page.locator('#playbackArt video');
  await expect(video).toHaveCount(1);
  const original = await video.elementHandle();
  expect(original).not.toBeNull();
  await original!.evaluate(element => {
    Object.defineProperty(element, 'error', { value: { code: 2 } });
    element.dispatchEvent(new Event('fixture:video:error'));
    element.dispatchEvent(new Event('fixture:video:error'));
  });
  await expect(video).toHaveAttribute('data-url', /delivery=proxy/);
  expect(await original!.getAttribute('data-destroyed')).toBe('true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#playbackModal')).not.toHaveClass(/active/);
  await (await revealControl(page,open)).click();
  await expect(video).toHaveCount(1);
  const currentUrl = await video.getAttribute('data-url');
  await original!.evaluate(element => {
    element.dispatchEvent(new Event('fixture:video:ended'));
    element.dispatchEvent(new Event('fixture:video:error'));
    element.dispatchEvent(new Event('fixture:video:volumechange'));
  });
  await expect(video).toHaveAttribute('data-url', currentUrl!);
  await expect(page.locator('#playbackNowTitle')).toHaveText('Fixture A');
  await page.keyboard.press('Escape');
  await expect(video).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('library preloads the player without blocking cards and stops queued directory preparation on leaving', async ({page}, info) => {
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let playerLoads=0;
  await page.route('**/assets/vendor/artplayer-5.4.0.js',route=>{playerLoads++;return route.fulfill({contentType:'application/javascript',body:playerAdapter});});
  const targets=[1,2].map(fileId=>({directoryId:String(fileId).repeat(64),userId:'user-1',mediaId:101,fileId}));
  let allowTargets=info.project.name==='desktop';
  await page.route('**/api/playback/preparation-targets?**',route=>route.fulfill({json:{success:true,data:{targets:allowTargets?targets:[]}}}));
  let arrived!:()=>void, release!:()=>void, delivered!:()=>void;
  const started=new Promise<void>(resolve=>{arrived=resolve;}), held=new Promise<void>(resolve=>{release=resolve;}), finished=new Promise<void>(resolve=>{delivered=resolve;});
  const jobs:string[]=[];
  await page.route('**/playback/files/*/prepare',async route=>{
    jobs.push(route.request().url());arrived();await held;
    try{await route.fulfill({json:{success:true,data:{prepared:true}}});}catch{}finally{delivered();}
  });
  await page.goto('/?page=library');
  if(info.project.name!=='desktop')await (await revealControl(page,page.locator('.archive-nav-item[data-archive-scope="global"]'))).click();
  allowTargets=true;
  await started;
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"]')).toBeVisible();
  expect(playerLoads).toBe(1);expect(jobs).toHaveLength(1);
  await navigate(page,'accounts');release();await finished;
  await expect(page.locator('#archiveLibraryModal')).not.toHaveClass(/active/);
  expect(jobs).toHaveLength(1);
});

test('cached direct failure refreshes once, retains position, then uses the existing proxy fallback',async({page}, info)=>{
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  let playerLoads=0;
  await page.route('**/assets/vendor/artplayer-5.4.0.js',route=>{playerLoads++;return route.fulfill({contentType:'application/javascript',body:playerAdapter});});
  const item={bvid:'BV1ALPHA001',title:'Cached fixture',upperName:'UP',queuePosition:1,source:{userId:'user-1',mediaId:101},
    parts:[1,2].map(fileId=>({fileId,pageIndex:fileId,label:'P'+fileId,fingerprint:'cached-'+fileId,streamUrl:'/fixture-media/'+fileId,codec:'avc1'}))};
  await page.route('**/api/archive-library/playback-queue?**',route=>route.fulfill({json:{success:true,data:{mode:'library',page:1,pageSize:50,total:1,focusIndex:0,hasMore:false,items:[item]}}}));
  await page.route('**/playback/delivery/**',route=>route.fulfill({json:{success:true,data:{status:'direct',cachedDirect:true}}}));
  let nextPrepared=0;
  await page.route('**/playback/files/*/prepare',route=>{if(route.request().postDataJSON().kind==='link')nextPrepared++;return route.fulfill({json:{success:true,data:{prepared:true}}});});
  await page.goto('/?page=library');
  if(info.project.name!=='desktop')await (await revealControl(page,page.locator('.archive-nav-item[data-archive-scope="global"]'))).click();
  await (await revealControl(page,page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main'))).click();
  const video=page.locator('#playbackArt video');await expect(video).toHaveCount(1);
  await expect(page.locator('#playbackMessageTitle')).toHaveText('正在缓冲视频');
  await expect(page.locator('#playbackMessageDetail')).toContainText('已等待');
  await video.evaluate(element=>element.dispatchEvent(new Event('fixture:video:canplay')));
  await expect(page.locator('#playbackStageMessage')).toBeHidden();
  await expect.poll(()=>nextPrepared).toBe(1);
  const fail=async()=>{await video.evaluate(element=>{Object.defineProperty(element,'error',{value:{code:2},configurable:true});element.dispatchEvent(new Event('fixture:video:error'));element.dispatchEvent(new Event('fixture:video:error'));});};
  await fail();await expect(video).toHaveAttribute('data-url',/refresh=1/);
  await video.evaluate(element=>element.dispatchEvent(new Event('fixture:video:loadedmetadata')));
  await expect(video).toHaveAttribute('data-position','15');
  await fail();await expect(video).toHaveAttribute('data-url',/delivery=proxy/);
  await fail();await expect(page.locator('#playbackMessageTitle')).toHaveText('归档视频传输失败');
  await expect(video).toHaveCount(1);expect(playerLoads).toBe(1);
  await page.keyboard.press('Escape');await expect(video).toHaveCount(0);
});
