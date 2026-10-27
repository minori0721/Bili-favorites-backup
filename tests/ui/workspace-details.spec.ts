import {expect,test,type Page} from '@playwright/test';

test.beforeEach(async({page})=>{
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true,queueBoardMode:'media_retry',recoveryIssueKind:'download'}});
  await page.goto('/?page=overview');
  await expect(page.locator('#workspaceWaiting')).toHaveText('1');
});
async function navigate(page:Page,name:string){
  await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name,exact:true}).click();
}
async function category(page:Page,name:string){
  const picker=page.getByRole('combobox',{name:'设置分类'});
  if(await picker.isVisible())await picker.selectOption({label:name});
  else await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name,exact:true}).click();
}
async function showArchive(page:Page){
  await navigate(page,'归档库');
  const all=page.locator('.archive-nav-item[data-archive-scope="global"]');
  if(await all.isVisible())await all.click();
  await expect(page.locator('#archiveLibraryFilterbar')).toBeVisible();
}

test('overview continues to show the shared queue snapshot while the log is selected',async({page})=>{
  await navigate(page,'任务');await page.locator('#logSimpleBtn').click();await navigate(page,'概览');
  await expect(page.locator('#workspaceWaiting')).toHaveText('1');
  await expect(page.locator('#workspaceRecentTasks')).not.toContainText('队列暂时没有任务');
  await expect(page.locator('#workspaceRecentTasks')).toContainText('画质或编码待确认');
  await expect(page.locator('#workspaceSchedulerTitle')).not.toHaveText('正在读取调度状态');
});

test('restoring the application does not duplicate workspace controls or lose the page',async({page})=>{
  await navigate(page,'账号');await expect(page.locator('.user-actions .workspace-more')).toHaveCount(1);
  for(let index=0;index<2;index++){
    await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
    await expect(page.locator('.workspace-app-header')).toHaveCount(1);
    await expect(page.locator('body > main > .workspace-rail')).toHaveCount(1);
    await expect(page.locator('.user-actions .workspace-more')).toHaveCount(1);
    await expect(page.locator('.account-section')).toBeVisible();
  }
  await navigate(page,'设置');await category(page,'视频命名');
  await expect(page.locator('#filenameTemplate')).toBeVisible();
});

test('cancelling browser-back navigation preserves the pending UP selection and URL',async({page})=>{
  await navigate(page,'账号');await navigate(page,'UP 订阅');await page.locator('#upAddBtn').click();
  await page.getByRole('checkbox',{name:'选择 山野观察员'}).check();
  await page.goBack();await expect(page.locator('#confirmActionModal')).toBeVisible();
  await page.locator('#confirmActionCancelBtn').click();
  await expect(page).toHaveURL(/page=subscriptions/);
  await expect(page.getByRole('checkbox',{name:'选择 山野观察员'})).toBeChecked();
});

test('unknown page links fall back to a usable overview',async({page})=>{
  await page.goto('/?page=unknown');
  await expect(page.locator('.workspace-overview')).toBeVisible();
  await expect(page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'概览',exact:true})).toHaveAttribute('aria-current','page');
});

for(const cancelFirst of [false,true])test('navigation closes nested UP dialogs and restores the recovery header: cancelFirst='+cancelFirst,async({page})=>{
  await navigate(page,'UP 订阅');await page.locator('#upAddBtn').click();
  await page.getByRole('checkbox',{name:'选择 山野观察员'}).check();
  await page.locator('.up-person').filter({hasText:'影视飓风'}).getByRole('button',{name:'已订阅'}).click();
  await expect(page.locator('#upWorkspaceModal')).toBeVisible();await navigate(page,'任务');
  await expect(page.locator('#confirmActionModal')).toBeVisible();
  if(cancelFirst){
    await page.locator('#confirmActionCancelBtn').click();
    await expect(page.locator('#upAddModal')).toHaveAttribute('aria-modal','true');
    await expect(page.getByRole('checkbox',{name:'选择 山野观察员'})).toBeChecked();
    await page.locator('[data-up-close="upAddModal"]').click();
  }
  await page.locator('#confirmActionOkBtn').click();
  if(cancelFirst){await expect(page.locator('#upAddModal')).toBeHidden();await navigate(page,'任务');}
  await expect(page.locator('#upAddModal')).toBeHidden();await expect(page.locator('.workspace-task-panel')).toBeVisible();
  await page.locator('#recoveryIssuesBtn').click();
  await expect(page.locator('.recovery-issues-header')).not.toHaveAttribute('inert','');
  await page.getByRole('button',{name:'返回任务'}).click();await expect(page.locator('#recoveryIssuesModal')).toBeHidden();
  await expect(page.locator('.workspace-task-panel')).toBeVisible();
});

test('overview uses complete totals and raw subscription enablement',async({page})=>{
  await page.route('**/api/queue/state',async route=>{
    const response=await route.fetch(),body=await response.json();body.data.summary={running:2,waiting:60};await route.fulfill({json:body});
  });
  await page.route('**/api/up-subscriptions',async route=>{
    const response=await route.fetch(),body=await response.json();body.data.items[0].enabled=false;body.data.items[0].accountAvailable=false;await route.fulfill({json:body});
  });
  await page.reload();await expect(page.locator('#workspaceRunning')).toHaveText('2');await expect(page.locator('#workspaceWaiting')).toHaveText('60');
  await expect(page.locator('#workspaceSubscriptionHint')).toHaveText('2 个持续订阅，1 个已暂停');
});

test('changing settings categories does not manufacture an unsaved draft',async({page})=>{
  await navigate(page,'设置');await category(page,'视频命名');await category(page,'队列与重试');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
});

test('player buttons, settings and seek support keyboard on a real local video',async({page},info)=>{
  test.skip(info.project.name!=='desktop','实体触摸设备的系统播放控件需另外验收');
  await showArchive(page);await page.locator('#archiveLibraryGrid .archive-library-card-main').first().click();
  const player=page.locator('#playbackArt'),video=player.locator('video');
  await expect.poll(()=>video.evaluate((node:HTMLVideoElement)=>node.readyState)).toBeGreaterThan(0);
  expect(await video.evaluate((node:HTMLVideoElement)=>node.duration)).toBeGreaterThanOrEqual(59);
  const toggle=player.getByRole('button',{name:'暂停',exact:true});await toggle.focus();await page.keyboard.press('Enter');
  await expect.poll(()=>video.evaluate((node:HTMLVideoElement)=>node.paused)).toBe(true);
  const progress=player.getByRole('slider',{name:'播放进度'});await progress.focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
  await expect.poll(()=>video.evaluate((node:HTMLVideoElement)=>node.currentTime)).toBeGreaterThanOrEqual(4.9);
  const settings=player.locator('.art-control-setting');await expect(settings).toHaveAttribute('role','button');await settings.focus();await page.keyboard.press('Enter');
  await expect(settings).toHaveAttribute('aria-expanded','true');
  await expect(player.locator('.art-setting-item').first()).toBeFocused();await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();await expect(page.locator('#playbackModal')).toBeVisible();
});

test('favorite explanation matches the available detail button and cancel does not save',async({page})=>{
  let writes=0;page.on('request',request=>{if(request.method()==='PUT'&&/\/favorites$/.test(new URL(request.url()).pathname))writes++;});
  await navigate(page,'账号');await page.getByRole('button',{name:'选择同步收藏夹'}).click();
  await expect(page.locator('#favoritesModal')).toContainText('点击“查看详情”可查看视频');
  const folder=page.locator('#favoritesList .fav-label').first();
  await expect(folder.locator('input')).toBeChecked();await folder.locator('.fav-title').click();await expect(folder.locator('input')).not.toBeChecked();
  await page.locator('#closeFavoritesBtn').click();expect(writes).toBe(0);
});

test('empty archive filters say why and offer an action to see all',async({page})=>{
  await showArchive(page);await page.locator('[data-archive-filter="retained"]').click();
  await expect(page.locator('#archiveLibraryGrid')).toContainText('没有符合当前筛选条件的归档');
  await page.locator('#archiveLibraryGrid').getByRole('button',{name:'查看全部'}).click();
  await expect(page.locator('#archiveLibraryGrid .archive-library-card')).toHaveCount(6);
});

test('UP selection is protected from the backdrop and explicit close preserves or discards as chosen',async({page})=>{
  await navigate(page,'UP 订阅');await page.locator('#upAddBtn').click();
  await page.getByRole('checkbox',{name:'选择 山野观察员'}).check();
  await page.locator('#upAddModal').click({position:{x:2,y:2}});
  await expect(page.locator('#upAddModal')).toHaveClass(/active/);
  await page.locator('[data-up-close="upAddModal"]').click();
  await expect(page.locator('#confirmActionModal')).toContainText('放弃添加订阅');
  await page.locator('#confirmActionCancelBtn').click();
  await expect(page.getByRole('checkbox',{name:'选择 山野观察员'})).toBeChecked();
  await page.locator('[data-up-close="upAddModal"]').click();await page.locator('#confirmActionOkBtn').click();
  await expect(page.locator('#upAddModal')).toBeHidden();
  await page.locator('#upAddBtn').click();await expect(page.getByRole('checkbox',{name:'选择 山野观察员'})).not.toBeChecked();
  await page.locator('[data-up-close="upAddModal"]').click();await expect(page.locator('#confirmActionModal')).toBeHidden();
});

test('short workspaces keep selected posts and pagination reachable',async({page},info)=>{
  await page.setViewportSize({width:info.project.name==='desktop'?1024:844,height:390});
  await navigate(page,'UP 订阅');
  await page.locator('#upHomeList .up-subscription-card').filter({hasText:'影视飓风'}).locator('[data-up-manage]').click();
  const selected=page.locator('#upCatalogList input[data-up-video]').first();
  await selected.check();await expect(page.locator('#upCatalogPicked')).toHaveText('已选 1 个');
  await page.locator('#upCatalogMore').click();await expect(page.locator('#upCatalogList .up-video')).toHaveCount(42);
  await expect(selected).toBeChecked();await selected.uncheck();
  await expect(page.locator('#upCatalogPicked')).toHaveText('已选 0 个');
  await expect(page.locator('.up-selection-bar')).toHaveCSS('position','static');
  if(info.project.name!=='desktop'){
    const panel=await page.locator('#upWorkspaceModal>.panel').boundingBox();
    const nav=await page.locator('#upWorkspaceModal>.workspace-rail').boundingBox();
    expect(panel!.y+panel!.height).toBeLessThanOrEqual(nav!.y+1);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('short-workspace.png'),animations:'disabled'});
});

test('unsaved settings survive internal navigation and protect a document reload',async({page})=>{
  await navigate(page,'设置');await page.locator('#pollInterval').fill('7');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await navigate(page,'账号');await navigate(page,'设置');await expect(page.locator('#pollInterval')).toHaveValue('7');
  const dialogPromise=page.waitForEvent('dialog');
  const reload=page.reload({waitUntil:'commit',timeout:2000}).catch(()=>null);
  const dialog=await dialogPromise;expect(dialog.type()).toBe('beforeunload');await dialog.dismiss();await reload;
  await expect(page.locator('#pollInterval')).toHaveValue('7');
  await page.locator('#pollInterval').fill('5');await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
});

test('naming variables are keyboard controls and can be reordered without dragging',async({page})=>{
  await navigate(page,'设置');await category(page,'视频命名');
  await expect(page.locator('.template-note')).toContainText('点击 × 移除');
  await page.getByRole('button',{name:'下移视频标题'}).click();
  await expect(page.locator('#filenameTemplate')).toHaveValue('<bvid>-<videoTitle>');
  await page.getByRole('button',{name:'移除BV号'}).click();
  await expect(page.locator('#filenameTemplate')).toHaveValue('<videoTitle>');
  const available=page.locator('#templateTags').getByRole('button',{name:'UP主'});await available.focus();await page.keyboard.press('Enter');
  await expect(page.locator('#filenameTemplate')).toHaveValue('<videoTitle>-<ownerName>');
});

test('player uses the bundled local video without preview-only UI',async({page})=>{
  await showArchive(page);await page.locator('#archiveLibraryGrid .archive-library-card-main').first().click();
  await expect(page.locator('#playbackModal')).toHaveClass(/active/);
  await expect(page.locator('[class*=playback-note]')).toHaveCount(0);
  await expect(page.locator('#playbackArt video')).toHaveCount(1);
  await expect.poll(()=>page.locator('#playbackArt video').evaluate((video:HTMLVideoElement)=>video.readyState)).toBeGreaterThan(0);
});

test('player resource failure does not claim the login is the cause',async({page})=>{
  await page.route('**/assets/vendor/artplayer-5.4.0.js',route=>route.fulfill({status:404,body:''}));
  await showArchive(page);await page.locator('#archiveLibraryGrid .archive-library-card-main').first().click();
  await expect(page.locator('#playbackMessageDetail')).toContainText('播放器资源加载失败');
  await expect(page.locator('#playbackMessageDetail')).not.toContainText('重新登录');
});

test('online content and UP workspaces keep the same header and contextual navigation',async({page})=>{
  await page.getByRole('button',{name:'浏览在线内容 ↗'}).click();
  const online=page.locator('#onlineContentModal');await expect(online.locator(':scope > .workspace-app-header')).toBeVisible();
  await expect(online.locator('.online-content-card')).toHaveCount(1);
  await expect(online.locator('.online-content-card')).toHaveCSS('border-top-left-radius','16px');
  await online.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'UP 订阅'}).click();
  await page.locator('#upHomeList [data-up-manage]').first().click();
  const up=page.locator('#upWorkspaceModal');await expect(up.locator(':scope > .workspace-app-header')).toBeVisible();
  await expect(up.getByRole('button',{name:'返回订阅列表'})).toBeVisible();
});

test('small-screen controls stay usable without horizontal overflow',async({page},info)=>{
  if(info.project.name==='desktop')test.skip();
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    const header=page.locator('.workspace-app-header'),brand=header.locator('h1'),actions=header.locator('.header-actions');
    const a=await brand.boundingBox(),b=await actions.boundingBox();expect(a&&b&&Math.abs(a.y-b.y)).toBeLessThan(18);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await navigate(page,'设置');await category(page,'下载画质与编码');
  const box=await page.getByRole('button',{name:'下移 HEVC'}).boundingBox();expect(box?.width).toBeGreaterThanOrEqual(44);expect(box?.height).toBeGreaterThanOrEqual(44);
  const help=await page.locator('#settingsHelpBtn').boundingBox();expect(help?.width).toBeGreaterThanOrEqual(44);expect(help?.height).toBeGreaterThanOrEqual(44);
  await navigate(page,'概览');await page.getByRole('button',{name:'浏览在线内容 ↗'}).click();
  await expect(page.locator('#onlineContentTitle')).toHaveText('在线收藏夹');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    const heading=page.locator('#onlineContentTitle');
    expect(await heading.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await expect(page.locator('#onlineContentMobileBackBtn')).toBeVisible();
    await expect(page.locator('#onlineContentCloseMainBtn')).toBeVisible();
  }
  await page.locator('#onlineContentMobileBackBtn').click();
  await expect(page.locator('#onlineContentNav')).toBeVisible();
  await page.locator('#onlineContentNav .archive-nav-item').first().click();
  await expect(page.locator('#onlineContentTitle')).toBeVisible();
  await page.locator('#onlineContentCloseMainBtn').click();
  await expect(page.locator('#onlineContentModal')).toBeHidden();
  await expect(page.locator('.workspace-overview')).toBeVisible();
});

test('capture trial layout for visual review',async({page},info)=>{
  await expect.poll(()=>page.locator('#workspaceRecentSubscriptions img').evaluateAll(images=>images.every(image=>image instanceof HTMLImageElement&&image.complete&&image.naturalWidth>0))).toBe(true);
  await page.screenshot({path:info.outputPath('overview.png'),animations:'disabled'});
  await navigate(page,'设置');await category(page,'视频命名');
  await page.screenshot({path:info.outputPath('settings.png'),animations:'disabled'});
  await navigate(page,'UP 订阅');await page.locator('#upHomeList [data-up-manage]').first().click();
  await expect(page.locator('#upWorkspaceModal')).toBeVisible();
  await page.screenshot({path:info.outputPath('up-workspace.png'),animations:'disabled'});
  await page.locator('#upWorkspaceModal').getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'概览'}).click();
  await page.getByRole('button',{name:'浏览在线内容 ↗'}).click();
  await expect(page.locator('#onlineContentModal')).toBeVisible();
  await expect(page.locator('.online-content-card')).toHaveCount(1);
  await page.screenshot({path:info.outputPath('online-content.png'),animations:'disabled'});
});
