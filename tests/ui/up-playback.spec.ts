import { expect,test,type APIResponse,type Page } from '@playwright/test';
import { isRecord } from '../../src/shared/api/value.js';
import { parseUpList } from '../../src/shared/api/up-subscriptions.js';
import { parseArchiveNavigation,parseArchiveDeletion } from '../../src/shared/api/archive-library.js';
import { parseArchiveVideoPreview } from '../../src/shared/api/archive-video-actions.js';

const bvid='BVUP163637592X001';
const playerAdapter=`window.Artplayer=class {
  constructor(options){this.video=document.createElement('video');this.video.dataset.url=options.url;options.container.append(this.video);this.currentTime=0;this.duration=120;this.volume=.5;this.muted=false;this.playbackRate=1;}
  on(name,callback){this.video.addEventListener('fixture:'+name,callback);return this;}
  play(){return Promise.resolve();}pause(){}destroy(){this.video.remove();}
};`;
async function body(response:APIResponse){const value:unknown=await response.json();if(!isRecord(value)||value.success!==true)throw new Error('Unexpected fixture API response');return value.data;}
async function openWorkspace(page:Page){await page.locator('#upHomeList .up-subscription-card').filter({hasText:'老师好我叫何同学'}).getByRole('button',{name:'投稿选择',exact:true}).click();await expect(page.locator(`[data-up-card="${bvid}"]`)).toBeVisible();}
test.beforeEach(async({page})=>{
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  await page.route('**/assets/vendor/artplayer-5.4.0.js',route=>route.fulfill({contentType:'application/javascript',body:playerAdapter}));
  await page.goto('/');
});

for(const previousFavorite of [false,true])test(`UP playback uses its own real SQLite queue: previous favorite=${previousFavorite}`,async({page})=>{
  const requests:string[]=[];page.on('request',request=>{if(request.url().includes('playback-queue'))requests.push(request.url());});
  if(previousFavorite){await page.locator('[data-action="favorite_detail"]').first().click();await expect(page.locator('#videoDetailModal')).toHaveClass(/active/);await page.locator('#closeVideoDetailBtn').click();}
  const list=parseUpList(await body(await page.request.get('/api/up-subscriptions'))),subscription=list.items.find(item=>item.uid===163637592)!;
  const source=parseArchiveNavigation(await body(await page.request.get('/api/archive-library/navigation'))).upSubscriptions.find(item=>item.sourceId===subscription.id)!;
  await openWorkspace(page);await page.locator(`[data-up-card="${bvid}"]`).getByRole('button',{name:'播放',exact:true}).click();
  await expect(page.locator('#playbackModal')).toHaveClass(/active/);await expect(page.locator('#playbackArt video')).toHaveCount(1);
  await expect(page.locator('#playbackNowTitle')).toContainText('我们用一台摄影机');
  expect(requests).toHaveLength(1);const queue=new URL(requests[0]);expect(queue.pathname).toBe('/api/archive-library/playback-queue');
  expect(queue.searchParams.get('scope')).toBe('folder');expect(queue.searchParams.get('mediaId')).toBe(String(source.mediaId));expect(queue.searchParams.get('userId')).toBe(source.userId);expect(queue.searchParams.get('focusBvid')).toBe(bvid);
  await expect(page.locator('#playbackArt video')).toHaveAttribute('data-url',new RegExp('/favorites/'+source.mediaId+'/playback/files/'));
  await page.locator('#playbackModal').getByRole('button',{name:'关闭播放器',exact:true}).filter({visible:true}).click();await expect(page.locator('#upWorkspaceModal')).toHaveClass(/active/);
});

test('UP existing archive playback stays on the same BV when only other sources retain a copy',async({page})=>{
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true}});await page.reload();
  const subscription=parseUpList(await body(await page.request.get('/api/up-subscriptions'))).items.find(item=>item.uid===163637592)!;
  const preview=parseArchiveVideoPreview(await body(await page.request.post(`/api/archive-library/items/${bvid}/actions/preview`,{data:{sourceId:subscription.id,scope:'source',effect:'delete'}})));
  const result=await body(await page.request.post(`/api/archive-library/items/${bvid}/actions/commit`,{data:{previewId:preview.previewId,confirmation:preview.confirmation}}));
  if(!isRecord(result))throw new Error('Missing fixture operation');const operation=parseArchiveDeletion(result.operation);
  await expect.poll(async()=>parseArchiveDeletion(await body(await page.request.get('/api/archive-deletions/'+operation.id))).status).toBe('completed');
  const queues:string[]=[];page.on('request',request=>{if(request.url().includes('playback-queue'))queues.push(request.url());});
  await openWorkspace(page);await page.locator(`[data-up-card="${bvid}"]`).getByRole('button',{name:'已有归档',exact:true}).click();
  await expect(page.locator('#playbackArt video')).toHaveCount(1);expect(queues).toHaveLength(1);
  const queue=new URL(queues[0]);expect(queue.searchParams.get('scope')).toBe('global');expect(queue.searchParams.get('q')).toBe(bvid);expect(queue.searchParams.get('filter')).toBe('playable');
  await expect(page.locator('#playbackArt video')).toHaveAttribute('data-url',/\/favorites\/(11|12)\/playback\/files\//);
});

test('closing UP workspace cancels a pending playback source and a late reply cannot open the player',async({page})=>{
  let release!:()=>void,received!:()=>void,delivered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{received=resolve;}),finished=new Promise<void>(resolve=>{delivered=resolve;});
  await page.route('**/api/archive-library/navigation',async route=>{const response=await route.fetch();received();await held;try{await route.fulfill({response});}finally{delivered();}});
  await openWorkspace(page);await page.locator(`[data-up-card="${bvid}"]`).getByRole('button',{name:'播放',exact:true}).click();await requested;
  await page.getByRole('button',{name:'关闭 UP 订阅',exact:true}).click();release();await finished;
  await expect(page.locator('#playbackModal')).not.toHaveClass(/active/);await page.unroute('**/api/archive-library/navigation');
  await openWorkspace(page);await page.locator(`[data-up-card="${bvid}"]`).getByRole('button',{name:'播放',exact:true}).click();await expect(page.locator('#playbackArt video')).toHaveCount(1);
});

test('missing UP playback source reports an error instead of using a previous or global queue',async({page})=>{
  const navigation=parseArchiveNavigation(await body(await page.request.get('/api/archive-library/navigation')));
  await page.route('**/api/archive-library/navigation',route=>route.fulfill({json:{success:true,data:{...navigation,upSubscriptions:[]}}}));
  const queues:string[]=[];page.on('request',request=>{if(request.url().includes('playback-queue'))queues.push(request.url());});
  await openWorkspace(page);await page.locator(`[data-up-card="${bvid}"]`).getByRole('button',{name:'播放',exact:true}).click();
  await expect(page.locator('#upWorkspaceStatus')).toContainText('UP 归档来源已变化');await expect(page.locator('#playbackModal')).not.toHaveClass(/active/);expect(queues).toEqual([]);
});
