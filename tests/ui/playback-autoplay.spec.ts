import {expect,test} from '@playwright/test';
import {revealControl} from './workspace-navigation.js';

const pausedPlayer=`window.Artplayer=class {
  constructor(options){this.video=document.createElement('video');options.container.append(this.video);this.template={$player:options.container,$setting:document.createElement('div')};this.setting={show:false};this.controls={show:true};this.currentTime=0;this.duration=120;this.volume=.5;this.muted=false;this.playbackRate=1;}
  on(name,callback){this.video.addEventListener('fixture:'+name,callback);return this;}
  once(name,callback){this.video.addEventListener('fixture:'+name,callback,{once:true});return this;}
  play(){return Promise.resolve();}pause(){}destroy(){this.video.remove();}
};`;

test('metadata-ready paused media releases the waiting overlay so manual playback remains available',async({page},info)=>{
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:''}));
  await page.route('**/assets/vendor/artplayer-5.4.0.js',route=>route.fulfill({contentType:'application/javascript',body:pausedPlayer}));
  await page.route('**/playback/delivery/**',route=>route.fulfill({json:{success:true,data:{status:'direct'}}}));
  await page.route('**/api/archive-library/playback-queue?**',route=>route.fulfill({json:{success:true,data:{
    mode:'library',page:1,pageSize:50,total:1,focusIndex:0,hasMore:false,items:[{
      bvid:'BV1ALPHA001',title:'Paused media',queuePosition:1,source:{userId:'user-1',mediaId:101},
      parts:[{fileId:1,pageIndex:1,label:'P1',fingerprint:'paused-fixture',streamUrl:'/fixture-media/paused',codec:'avc1'}],
    }],
  }}}));
  await page.goto('/?page=library');
  if(info.project.name!=='desktop')await (await revealControl(page,page.locator('.archive-nav-item[data-archive-scope="global"]'))).click();
  await (await revealControl(page,page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main'))).click();
  const video=page.locator('#playbackArt video');await expect(video).toHaveCount(1);
  await expect(page.locator('#playbackStageMessage')).toBeVisible();
  expect(await video.evaluate(node=>node instanceof HTMLVideoElement && node.paused)).toBe(true);
  await video.evaluate(node=>node.dispatchEvent(new Event('fixture:video:loadedmetadata')));
  await expect(page.locator('#playbackStageMessage')).toBeHidden();
  await expect(video).toBeVisible();
  await page.keyboard.press('Escape');await expect(video).toHaveCount(0);
});
