import {test,expect,type Page} from '@playwright/test';
import {isRecord} from '../../src/shared/api/value.js';
import {parseUpList,parseUpSubscription,parseUpCatalog} from '../../src/shared/api/up-subscriptions.js';
async function data(page:Page,path:string){const value:unknown=await(await page.request.get(path)).json();if(!isRecord(value))throw new Error('Invalid test response');return value.data;}
async function pageHidden(page:Page,hidden:boolean){await page.evaluate(value=>{Object.defineProperty(document,'hidden',{configurable:true,value});document.dispatchEvent(new Event('visibilitychange'));},hidden);}
test.beforeEach(async({page})=>{
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({status:200,contentType:'text/css',body:''}));
  await page.goto('/');
  await expect(page.locator('#upHomeList .up-subscription-card')).toHaveCount(3);
});

test('home polling pauses while hidden and updates counts without replacing cards or focus', {tag:'@desktop-only'}, async({page})=>{
  const listing=parseUpList(await data(page,'/api/up-subscriptions')),source=listing.items[0];
  if(!source)throw new Error('missing subscription fixture');
  let calls=0,archivedCount=source.archivedCount;
  await page.clock.install();
  await page.route('**/api/up-subscriptions',route=>{
    calls++;
    return route.fulfill({json:{success:true,data:{...listing,items:listing.items.map(item=>item.id===source.id?{...item,archivedCount}:item),
      operations:[{id:'polling-fixture',sourceId:source.id,sourceName:source.name,status:'running',fileCount:2,completedCount:0,retainedCount:0,lastError:null}]}}});
  });
  await page.reload();await expect.poll(()=>calls).toBe(1);
  const card=page.locator('#upHomeList .up-subscription-card').filter({hasText:source.name});
  const trigger=card.getByRole('button',{name:'投稿选择',exact:true});
  const cardNode=await card.elementHandle(),buttonNode=await trigger.elementHandle();
  if(!cardNode||!buttonNode)throw new Error('missing rendered subscription');
  await trigger.focus();archivedCount++;
  await card.locator('.up-avatar img').dispatchEvent('error');await expect(card.locator('.up-avatar img')).toHaveCount(0);
  await page.clock.fastForward(5000);await expect(card.locator('.up-card-stats strong').first()).toHaveText(String(archivedCount));
  await expect(card.locator('.up-avatar img')).toHaveCount(1);
  expect(calls).toBe(2);expect(await cardNode.evaluate(node=>node.isConnected)).toBe(true);expect(await buttonNode.evaluate(node=>node.isConnected)).toBe(true);await expect(trigger).toBeFocused();
  await pageHidden(page,true);await page.clock.fastForward(30000);expect(calls).toBe(2);
  await pageHidden(page,false);await expect.poll(()=>calls).toBe(3);await expect(trigger).toBeFocused();
  await page.clock.fastForward(5000);await expect.poll(()=>calls).toBe(4);
});

test('workspace polling resumes once and closes without leaving a polling chain', {tag:'@desktop-only'}, async({page})=>{
  await page.clock.install();
  let calls=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/up-subscriptions'&&request.method()==='GET')calls++;});
  const trigger=page.locator('#upHomeList .up-subscription-card').filter({hasText:'影视飓风'}).getByRole('button',{name:'投稿选择',exact:true});
  await trigger.click();await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  await expect(page.locator('#upCatalogMore')).toBeEnabled();
  await pageHidden(page,true);await page.clock.fastForward(30000);expect(calls).toBe(0);
  await pageHidden(page,false);await expect.poll(()=>calls).toBe(1);
  await page.clock.fastForward(10000);await expect.poll(()=>calls).toBe(2);
  await page.locator('#upWorkspaceModal').getByRole('button',{name:'关闭 UP 订阅',exact:true}).click();
  await page.clock.fastForward(30000);expect(calls).toBe(2);
  await trigger.click();await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  await expect(page.locator('#upCatalogMore')).toBeEnabled();
  await page.clock.fastForward(10000);await expect.poll(()=>calls).toBe(3);
});

test('a late read from before foreground refresh cannot overwrite the new subscription snapshot', {tag:'@desktop-only'}, async({page})=>{
  const listing=parseUpList(await data(page,'/api/up-subscriptions')),source=listing.items[0];
  if(!source)throw new Error('missing subscription fixture');
  let calls=0,release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.clock.install();
  await page.route('**/api/up-subscriptions',async route=>{
    const call=++calls;if(call===2)await pending;
    await route.fulfill({json:{success:true,data:{...listing,items:listing.items.map(item=>item.id===source.id?{...item,archivedCount:call===2?source.archivedCount+1:source.archivedCount+2}:item)}}});
  });
  await page.reload();await expect.poll(()=>calls).toBe(1);
  try {
    await page.locator('#upRefreshBtn').click();await expect.poll(()=>calls).toBe(2);
    await pageHidden(page,true);await pageHidden(page,false);await expect.poll(()=>calls).toBe(3);
    release();
    await expect(page.locator('#upHomeList .up-subscription-card').filter({hasText:source.name}).locator('.up-card-stats strong').first()).toHaveText(String(source.archivedCount+2));
    await expect(page.locator('#upHomeStatus')).not.toHaveClass(/error/);
  } finally {release();}
});
test('subscription X opens the safe default, supports cancel and keeps archives on retain',async({page})=>{
  const card=page.locator('#upHomeList .up-subscription-card').filter({hasText:'老师好我叫何同学'});
  const trigger=card.getByRole('button',{name:'移除 老师好我叫何同学 的订阅'}),dialog=page.locator('#upRemovalModal');
  const before=parseUpList(await data(page,'/api/up-subscriptions')),source=before.items.find(item=>item.uid===163637592);expect(source).toBeDefined();if(!source)throw new Error('missing source');
  await trigger.click();await expect(dialog).toHaveClass(/active/);await expect(dialog.locator('input[value=retain]')).toBeChecked();
  const buttons=await dialog.evaluate(element=>{
    const read=(button:Element)=>{const style=getComputedStyle(button);return {height:button.getBoundingClientRect().height,fontSize:style.fontSize,padding:style.padding,borderRadius:style.borderRadius};};
    return {cancel:read(element.querySelector('.modal-actions .ghost')!),review:read(element.querySelector('#upRemovalReviewBtn')!)};
  });
  const {height:reviewHeight,...reviewStyle}=buttons.review,{height:cancelHeight,...cancelStyle}=buttons.cancel;
  expect(reviewStyle).toEqual(cancelStyle);
  expect(reviewHeight).toBeCloseTo(cancelHeight,1);
  await page.keyboard.press('Escape');await expect(dialog).not.toHaveClass(/active/);await expect(trigger).toBeFocused();
  expect(parseUpList(await data(page,'/api/up-subscriptions')).items.length).toBe(3);
  await trigger.click();await dialog.getByRole('button',{name:'确认移除',exact:true}).click();
  await expect(card).toHaveCount(0);await expect(dialog).not.toHaveClass(/active/);
  const removed=parseUpSubscription(await data(page,`/api/up-subscriptions/${source.id}`));expect(removed.removed).toBe(true);expect(removed.archivedCount).toBe(1);
  expect(parseUpList(await data(page,'/api/up-subscriptions')).operations).toEqual([]);
});
test('whole subscription deletion previews real counts, confirms once and keeps progress after the card disappears',async({page})=>{
  const card=page.locator('#upHomeList .up-subscription-card').filter({hasText:'影视飓风'});
  let commits=0;page.on('request',request=>{if(request.method()==='DELETE'&&request.url().includes('/api/up-subscriptions/'))commits++;});
  await card.getByRole('button',{name:'移除 影视飓风 的订阅'}).click();
  await page.locator('input[name=upRemovalEffect][value=delete]').check();await page.locator('#upRemovalReviewBtn').dblclick();
  await expect(page.locator('#confirmActionModal')).toHaveClass(/active/);await expect(page.locator('#confirmActionDetail')).toContainText('涉及 3 个视频');
  await expect(page.locator('#confirmActionDetail')).toContainText('预计实际删除 3 个文件');
  await expect(page.locator('#confirmActionDetail')).toContainText('预计释放 36.0 MB');await expect(page.locator('#confirmActionOkBtn')).toBeDisabled();
  expect(commits).toBe(0);await page.locator('#confirmActionInput').fill('DELETE ARCHIVE');await page.locator('#confirmActionOkBtn').click();
  await expect(card).toHaveCount(0);await expect(page.locator('#upRemovalOperations')).toContainText('影视飓风');
  await expect(page.locator('#upRemovalOperations')).toContainText('清理完成');expect(commits).toBe(1);
  await page.reload();await expect(page.locator('#upRemovalOperations')).toContainText('清理完成');
  await page.locator('#upAddBtn').click();await page.getByRole('checkbox',{name:'选择 影视飓风',exact:true}).check();await page.locator('#upToRulesBtn').click();await page.locator('#upCreateBtn').click();
  await expect(page.locator('#upWorkspaceTitle')).toHaveText('影视飓风');await expect(page.locator('#upWorkspaceMeta')).toContainText('已归档 0');
  await expect(page.locator('#upCatalogList')).toContainText('当前订阅已排除');await expect(page.locator('#upCatalogList')).not.toContainText('可播放');
});
test('failed whole cleanup is visible on home and retry works without the subscription card',async({page})=>{
  await page.request.post('/__test/up-deletion-failure',{data:{enabled:true}});
  const card=page.locator('#upHomeList .up-subscription-card').filter({hasText:'老师好我叫何同学'});
  await card.getByRole('button',{name:'移除 老师好我叫何同学 的订阅'}).click();await page.locator('input[name=upRemovalEffect][value=delete]').check();
  await page.locator('#upRemovalReviewBtn').click();await page.locator('#confirmActionInput').fill('DELETE ARCHIVE');await page.locator('#confirmActionOkBtn').click();
  await expect(card).toHaveCount(0);await expect(page.locator('#upRemovalOperations')).toContainText('清理失败');
  await page.reload();await expect(page.locator('#upRemovalOperations').getByRole('button',{name:'重新核对'})).toBeVisible();
  await page.request.post('/__test/up-deletion-failure',{data:{enabled:false}});
  await page.locator('#upRemovalOperations').getByRole('button',{name:'重试清理'}).click();await expect(page.locator('#upRemovalOperations')).toContainText('清理完成');
});
test('dialog titles share the soft white surface while the player keeps its dark surface',async({page})=>{
  await page.locator('#upHelpBtn').click();
  const audit=await page.evaluate(()=>{
    const color=getComputedStyle(document.getElementById('upHelpTitle')!).backgroundColor;
    const titles=[...document.querySelectorAll('.modal>.panel>h2,.modal>.panel>.section-title-row:first-child')];
    return {color,headers:titles.map(item=>getComputedStyle(item).backgroundColor),player:getComputedStyle(document.querySelector('.playback-shell')!).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth};
  });
  expect(audit.color).toBe('rgb(249, 253, 253)');expect(audit.headers.every(color=>color===audit.color)).toBe(true);expect(audit.player).not.toBe(audit.color);expect(audit.overflow).toBe(false);
});
test('UP dialogs keep four round corners, full-width soft white headings and an inset scrolling body',async({page})=>{
  await page.getByRole('button',{name:'移除 大象放映室 的订阅',exact:true}).click();
  const geometry=await page.locator('#upRemovalModal .panel').evaluate(panel=>{
    const style=getComputedStyle(panel),header=panel.querySelector('.up-dialog-heading')!,body=panel.querySelector('.up-dialog-body')!;
    const box=panel.getBoundingClientRect(),heading=header.getBoundingClientRect(),content=body.getBoundingClientRect();
    return {corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius],overflow:style.overflowY,gutter:style.scrollbarGutter,
      headerLeft:heading.left,panelLeft:box.left,headerRight:heading.right,panelRight:box.right,bodyRight:content.right,bodyBottom:content.bottom,panelBottom:box.bottom};
  });
  expect(geometry.corners.every(radius=>radius===geometry.corners[0]&&radius!=='0px')).toBe(true);expect(geometry.overflow).toBe('hidden');expect(geometry.gutter).toBe('auto');
  expect(Math.abs(geometry.headerLeft-geometry.panelLeft)).toBeLessThan(2);expect(Math.abs(geometry.headerRight-geometry.panelRight)).toBeLessThan(2);
  expect(geometry.bodyRight).toBeLessThan(geometry.panelRight-4);expect(geometry.bodyBottom).toBeLessThan(geometry.panelBottom-10);
});
test('an unsubscribed followed creator can be selected directly without a UID or a search',async({page})=>{
  await page.locator('#upAddBtn').click();await page.getByRole('checkbox',{name:'选择 山野观察员',exact:true}).check();
  await page.locator('#upToRulesBtn').click();await page.locator('input[name=upMode][value=from_now]').check();
  await page.locator('#upCreateBtn').click();await expect(page.locator('#upWorkspaceTitle')).toHaveText('山野观察员');
  await expect(page.locator('#upWorkspaceMeta')).toContainText('从设定时间起');
  await page.reload();await expect(page.locator('#upHomeList .up-subscription-card')).toHaveCount(4);
});
test('following search, global unfollowed discovery and selected-only creation work with the real backend',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#upAddBtn').click();await expect(page.locator('#upDiscoveryList')).toContainText('影视飓风');
  await page.getByRole('tab',{name:'搜索 UP',exact:true}).click();await page.locator('#upDiscoveryQuery').fill('摄影师');
  await page.locator('#upDiscoverySearchBtn').click();await expect(page.locator('#upDiscoveryList')).toContainText('摄影师陈杰');
  await page.getByRole('checkbox',{name:'选择 摄影师陈杰',exact:true}).check();await page.locator('#upToRulesBtn').click();
  await page.locator('input[name=upMode][value=selected]').check();await page.locator('#upCreateBtn').click();
  await expect(page.locator('#upWorkspaceModal')).toHaveClass(/active/);await expect(page.locator('#upWorkspaceTitle')).toHaveText('摄影师陈杰');
  await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);await expect(page.locator('#upCatalogList')).toContainText('不在归档范围');
  await page.locator('#upCatalogList input[data-up-video]').first().check();await page.locator('#upIncludeBtn').click();
  await expect(page.locator('#upCatalogList .up-video')).toContainText(['符合归档规则']);
  await page.reload();await page.locator('#upHomeList .up-subscription-card').filter({hasText:'摄影师陈杰'}).getByRole('button',{name:'投稿选择'}).click();
  await expect(page.locator('#upCatalogList')).toContainText('符合归档规则');expect(errors).toEqual([]);
});
test('catalog selection survives pagination and source exclusion preserves archived playback',async({page})=>{
  await page.locator('#upHomeList .up-subscription-card').filter({hasText:'影视飓风'}).getByRole('button',{name:'投稿选择'}).click();
  await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  const choice=page.locator('#upCatalogList input').first();await choice.press('Space');await expect(choice).toBeChecked();await expect(choice).toBeFocused();
  await expect(page.locator('#upCatalogPicked')).toHaveText('已选 1 个');
  await page.locator('#upCatalogMore').click();await expect(page.locator('#upCatalogList .up-video')).toHaveCount(42);await expect(page.locator('#upCatalogList input').first()).toBeChecked();
  const first=page.locator('#upCatalogList .up-video').first();await first.getByRole('button',{name:'管理归档'}).click();
  await page.locator('#upActionPreviewBtn').click();await expect(page.locator('#confirmActionModal')).toHaveClass(/active/);await page.locator('#confirmActionOkBtn').click();
  await expect(page.locator('#upActionStatus')).toContainText('已有文件保留');
  await page.getByRole('button',{name:'关闭归档管理',exact:true}).click();
  await expect(first).toContainText('当前订阅已排除');await expect(first.getByRole('button',{name:'播放',exact:true})).toBeVisible();
  await expect(first.getByRole('button',{name:'管理归档',exact:true})).toBeVisible();
  await page.locator('[data-up-filter=excluded]').click();await expect(page.locator('#upCatalogList')).toContainText('当前订阅已排除');
  await expect(page.locator('#upWorkspaceModal')).toBeVisible();
});
test('UP help explains setup, selection and deletion without starting an operation, and restores focus',async({page})=>{
  const writes:string[]=[];page.on('request',request=>{if(request.url().includes('/api/')&&!['GET','HEAD'].includes(request.method()))writes.push(request.url());});
  const help=page.locator('#upHelpBtn'),dialog=page.locator('#upHelpModal');
  await help.click();await expect(dialog).toHaveClass(/active/);
  await expect(dialog.getByRole('heading',{name:'UP 订阅怎么用？',exact:true})).toBeVisible();
  await expect(dialog).toContainText('搜索未关注的 UP');await expect(dialog).toContainText('新投稿不会自动下载');
  await expect(dialog).toContainText('删除归档，并排除此视频');await expect(dialog).toContainText('仅当前来源');
  await expect(dialog).toContainText('所有来源');await expect(dialog).toContainText('其他来源仍使用的文件会保留');
  await expect(dialog).toContainText('暂停订阅不会删除已有归档');await expect(dialog).toContainText('默认保留归档');
  await page.keyboard.press('Escape');await expect(dialog).not.toHaveClass(/active/);await expect(help).toBeFocused();
  await help.click();await dialog.getByRole('button',{name:'知道了',exact:true}).click();
  await expect(dialog).not.toHaveClass(/active/);await expect(help).toBeFocused();expect(writes).toEqual([]);
});

test('excluded videos retain management and playback, and explicit restore resumes selected-only membership',async({page})=>{
  const source=parseUpList(await data(page,'/api/up-subscriptions')).items.find(item=>item.uid===163637592)!;
  const item=parseUpCatalog(await data(page,`/api/up-subscriptions/${source.id}/items`)).items.find(item=>item.decision==='include')!;
  await page.locator('#upHomeList .up-subscription-card').filter({hasText:source.name}).getByRole('button',{name:'投稿选择',exact:true}).click();
  const card=page.locator(`[data-up-card="${item.bvid}"]`);
  await card.getByRole('button',{name:'管理归档',exact:true}).click();await page.locator('#upActionPreviewBtn').click();
  await expect(page.locator('#confirmActionModal')).toHaveAttribute('aria-modal','true');await page.locator('#confirmActionOkBtn').click();
  await expect(page.locator('#upActionStatus')).toContainText('已有文件保留');await page.getByRole('button',{name:'关闭归档管理',exact:true}).click();
  await expect(card.getByText('当前订阅已排除',{exact:true})).toBeVisible();await expect(card.getByText('可播放',{exact:true})).toBeVisible();
  await card.getByRole('button',{name:'管理归档',exact:true}).click();await page.locator('#archiveActionRestoreVideo').click();
  await expect(page.locator('#confirmActionMessage')).toContainText('加入单独选择');await page.locator('#confirmActionOkBtn').click();
  await expect(page.locator('#upActionStatus')).toContainText('已加入单独选择');
  const restored=parseUpCatalog(await data(page,`/api/up-subscriptions/${source.id}/items`)).items.find(entry=>entry.bvid===item.bvid)!;
  expect(restored.selected).toBe(true);expect(restored.playable).toBe(true);expect(restored.decision).toBe('include');
});

test('history cleanup confirms its new cutoff, keeps the subscription and leaves unarchived posts unexcluded',async({page})=>{
  const source=parseUpList(await data(page,'/api/up-subscriptions')).items.find(item=>item.uid===946974)!;
  const excludedBefore=parseUpCatalog(await data(page,`/api/up-subscriptions/${source.id}/items?filter=excluded`)).total;
  const card=page.locator('#upHomeList .up-subscription-card').filter({hasText:source.name});
  await card.getByRole('button',{name:'投稿选择',exact:true}).click();await page.locator('#upHistoryBtn').click();
  await expect(page.locator('#upRemovalTitle')).toHaveText('清理历史归档，继续订阅新投稿');
  await expect(page.locator('#upRemovalOptions')).toBeHidden();await expect(page.locator('#upHistoryHint')).toContainText('起点');
  await page.locator('#upRemovalReviewBtn').click();await expect(page.locator('#confirmActionModal')).toHaveAttribute('aria-modal','true');
  await page.locator('#confirmActionCancelBtn').click();await expect(page.locator('#upRemovalStatus')).toContainText('已取消本次提交');
  expect(parseUpSubscription(await data(page,`/api/up-subscriptions/${source.id}`)).revision).toBe(source.revision);
  await page.locator('#upRemovalReviewBtn').click();await expect(page.locator('#confirmActionModal')).toHaveAttribute('aria-modal','true');
  await expect(page.locator('#confirmActionDetail')).toContainText('此前的单独选择会取消');
  await page.locator('#confirmActionInput').fill('DELETE ARCHIVE');await page.locator('#confirmActionOkBtn').click();
  await expect(card).toBeVisible();await expect(card).toContainText('从设定时间起');
  await expect(page.locator('#upRemovalOperations')).toContainText('历史归档清理');await expect(page.locator('#upRemovalOperations')).toContainText('清理完成');
  const updated=parseUpSubscription(await data(page,`/api/up-subscriptions/${source.id}`));expect(updated.enabled).toBe(true);expect(updated.removed).toBe(false);expect(updated.mode).toBe('from_now');expect(updated.archivedCount).toBe(0);
  expect(parseUpCatalog(await data(page,`/api/up-subscriptions/${source.id}/items?filter=excluded`)).total).toBe(excludedBefore+3);
});
test('archive has an UP source directory and phone layout stays contained',async({page})=>{
  await page.locator('#upHomeList .up-subscription-card').filter({hasText:'影视飓风'}).getByRole('button',{name:'归档库 ↗'}).click();
  await expect(page.locator('#archiveLibraryModal')).toHaveClass(/active/);await expect(page.locator('#archiveLibraryTitle')).toContainText('UP 归档');
  await expect(page.locator('#archiveLibraryResults')).toContainText('我们用一台摄影机');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);expect(overflow).toBe(false);
});
test('workspace keeps its soft white header and single close reachable after scrolling, restoring focus',async({page})=>{
  const trigger=page.locator('#upHomeList .up-subscription-card').filter({hasText:'影视飓风'}).getByRole('button',{name:'投稿选择'});
  const workspace=page.locator('#upWorkspaceModal');
  const close=workspace.getByRole('button',{name:'关闭 UP 订阅',exact:true});
  await trigger.click();await expect(page.locator('#upCatalogList .up-video')).toHaveCount(30);
  await expect(workspace.locator('.up-workspace > .modal-actions')).toHaveCount(0);
  await expect(workspace.locator('[data-up-close]')).toHaveCount(1);
  await expect(workspace.locator('.panel')).toHaveCSS('transform','none');
  const headerTop=await workspace.locator('.up-dialog-heading').evaluate(element=>element.getBoundingClientRect().top);
  await page.locator('#upCatalogMore').scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  const header=await workspace.locator('.panel').evaluate(panel=>{
    const title=panel.querySelector<HTMLElement>('.up-dialog-heading')!;
    const body=panel.querySelector<HTMLElement>('.up-workspace-body')!;
    const box=panel.getBoundingClientRect(),heading=title.getBoundingClientRect(),content=body.getBoundingClientRect();
    const avatar=title.querySelector<HTMLElement>('#upWorkspaceAvatar')!,card=body.querySelector<HTMLElement>('.up-video')!;
    return {background:getComputedStyle(title).backgroundColor,top:heading.top,width:heading.width,panelWidth:panel.clientWidth,panelScroll:panel.scrollTop,bodyScroll:body.scrollTop,contentTop:content.top,headerBottom:heading.bottom,rightInset:box.right-content.right,bottomInset:box.bottom-content.bottom,avatarLeft:avatar.getBoundingClientRect().left,cardLeft:card.getBoundingClientRect().left};
  });
  expect(header.top).toBeGreaterThanOrEqual(0);expect(Math.abs(header.top-headerTop)).toBeLessThan(1);
  expect(Math.abs(header.width-header.panelWidth)).toBeLessThan(1);
  expect(header.panelScroll).toBe(0);expect(header.bodyScroll).toBeGreaterThan(0);
  expect(header.contentTop).toBeGreaterThan(header.headerBottom);
  expect(header.rightInset).toBeGreaterThanOrEqual(6);expect(header.bottomInset).toBeGreaterThanOrEqual(14);
  expect(header.rightInset).toBeLessThan(8);expect(Math.abs(header.cardLeft-header.avatarLeft)).toBeLessThan(1);
  expect(header.background).toBe('rgb(249, 253, 253)');
  await close.click();await expect(workspace).not.toHaveClass(/active/);await expect(trigger).toBeFocused();
  await trigger.click();await expect(workspace).toHaveClass(/active/);
  await page.keyboard.press('Escape');await expect(workspace).not.toHaveClass(/active/);await expect(trigger).toBeFocused();
});
test('search failure remains distinguishable from empty results and radio cutoff supports direct UID',async({page})=>{
  await page.locator('#upAddBtn').click();await page.getByRole('tab',{name:'搜索 UP',exact:true}).click();await page.locator('#upDiscoveryQuery').fill('请求失败');await page.locator('#upDiscoverySearchBtn').click();
  await expect(page.locator('#upDiscoveryStatus')).toContainText('请求失败');
  await page.getByRole('tab',{name:'UID / 链接',exact:true}).click();await page.locator('#upDiscoveryQuery').fill('https://space.bilibili.com/10710448');await page.locator('#upDiscoverySearchBtn').click();
  await page.getByRole('checkbox',{name:'选择 摄影师陈杰',exact:true}).check();await page.locator('#upToRulesBtn').click();await page.locator('input[name=upMode][value=from_video]').check();
  await expect(page.locator('#upAnchorVideo option')).toHaveCount(30);await page.locator('#upCreateBtn').click();
  await expect(page.locator('#upWorkspaceMeta')).toContainText('从视频开始');
  const anchor=await page.locator('#upUpdateAnchor').inputValue();expect(anchor).not.toBe('');
  await page.locator('#upCatalogQuery').fill('生活');await page.locator('#upCatalogSearchForm button').click();
  await expect(page.locator('#upCatalogList')).toContainText('生活');await expect(page.locator('#upUpdateAnchor')).toHaveValue(anchor);
  await page.locator('#upWorkspaceModal .up-settings summary').click();await page.locator('#upUpdateBtn').click();
  await expect(page.locator('#upUpdateAnchor')).toHaveValue(anchor);await expect(page.locator('#upWorkspaceStatus')).not.toHaveClass(/error/);
});
