import {test, expect, type Locator, type Page} from '@playwright/test';
import {navigate, revealControl} from './workspace-navigation.js';

const bv = 'BV13tWqzAEFG';
async function openExternal(page: Page, link: Locator, keyboard = false, expected = /^https:\/\/www\.bilibili\.com\/video\/(BV13tWqzAEFG|av170001)\/$/) {
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('href', expected);
  const popup = page.waitForEvent('popup');
  if (keyboard) { await link.focus(); await link.press('Enter'); }
  else await link.click();
  const external = await popup;
  await external.waitForLoadState('domcontentloaded');
  expect(external.url()).toMatch(expected);
  await external.close();
  await expect(page.locator('#playbackModal')).not.toHaveClass(/active/);
}

test.beforeEach(async ({page, context}) => {
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({body:''}));
  // Verify native navigation without contacting B站 or requiring a working video.
  await context.route('https://www.bilibili.com/**', route => route.fulfill({contentType:'text/html', body:'<title>B站链接测试</title>'}));
  await context.route('https://space.bilibili.com/**', route => route.fulfill({contentType:'text/html', body:'<title>UP 主页链接测试</title>'}));
});

test('archive video links are independent of playback and appear in source details', async ({page}, info) => {
  let playbackRequests = 0;
  page.on('request', request => { if (request.url().includes('/playback-queue')) playbackRequests++; });
  await page.route('**/api/archive-library/items?**', async route => {
    const response = await route.fetch(), body = await response.json();
    body.data.items[1].bvid = bv;
    await route.fulfill({response, json:body});
  });
  await page.route(`**/api/archive-library/items/${bv}?**`, async route => {
    const response = await route.fetch(), body = await response.json();
    body.data.bvid = bv;
    await route.fulfill({response, json:body});
  });
  await page.goto('/?page=library');
  if (info.project.name !== 'desktop') await page.locator('.archive-nav-item[data-archive-scope="global"]').click();
  const card = page.locator(`[data-archive-bvid="${bv}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('button a')).toHaveCount(0);
  await expect(card.locator('.bilibili-profile-link')).toHaveCount(0);
  await openExternal(page, page.locator('[data-archive-bvid="BV1ALPHA001"] .bilibili-profile-link'), true, /^https:\/\/space\.bilibili\.com\/163637592$/);
  await openExternal(page, card.locator('.bilibili-video-link'), true);
  await expect(page.locator('#archiveLibraryDetail')).not.toHaveClass(/open/);
  await card.locator('.archive-library-card-more').click();
  await expect(page.locator('#archiveLibraryDetail')).toHaveClass(/open/);
  await openExternal(page, page.locator('#archiveLibraryDetailBody .bilibili-video-link'));
  await openExternal(page, page.locator('#archiveLibraryDetailBody .bilibili-profile-link'), false, /^https:\/\/space\.bilibili\.com\/163637592$/);
  expect(playbackRequests).toBe(0);
});

test('UP catalog links do not toggle selection or open archive playback', async ({page}) => {
  await page.route('**/api/up-subscriptions/*/items?**', async route => {
    const response = await route.fetch(), body = await response.json();
    body.data.items[0].bvid = bv;
    await route.fulfill({response, json:body});
  });
  await page.goto('/?page=subscriptions');
  await openExternal(page, page.locator('#upHomeList .up-subscription-card').filter({hasText:'老师好我叫何同学'}).locator('.bilibili-profile-link'), false, /^https:\/\/space\.bilibili\.com\/163637592$/);
  await expect(page.locator('#upWorkspaceModal')).not.toHaveClass(/active/);
  await page.locator('#upHomeList .up-subscription-card').filter({hasText:'老师好我叫何同学'}).getByRole('button', {name:'投稿选择'}).click();
  const card = page.locator(`[data-up-card="${bv}"]`);
  await expect(card).toBeVisible();
  await card.locator('input').check();
  await openExternal(page, card.locator('.bilibili-video-link'));
  await openExternal(page, card.locator('.bilibili-profile-link'), true, /^https:\/\/space\.bilibili\.com\/163637592$/);
  const joint = page.locator('#upCatalogList .up-video').filter({hasText:'联合创作者'}).first();
  await openExternal(page, joint.locator('.bilibili-profile-link'), false, /^https:\/\/space\.bilibili\.com\/407054668$/);
  await expect(card.locator('input')).toBeChecked();
  await expect(page.locator('#upCatalogPicked')).toHaveText('已选 1 个');
});

test('online AV links open the original video without starting an archive', async ({page}) => {
  let archiveRequests = 0;
  page.on('request', request => { if (request.url().includes('/api/media-probe') || request.url().includes('/manual-archive')) archiveRequests++; });
  await page.route('**/api/online-content/items?**', async route => {
    const response = await route.fetch(), body = await response.json();
    body.data.items[0].bvid = 'av170001';
    await route.fulfill({response, json:body});
  });
  await page.goto('/?page=overview');
  await (await revealControl(page, page.getByRole('button', {name:'浏览在线内容 ↗', exact:true}))).click();
  await openExternal(page, page.locator('.online-content-card .bilibili-video-link'));
  await openExternal(page, page.locator('.online-content-card .bilibili-profile-link'), false, /^https:\/\/space\.bilibili\.com\/163637592$/);
  expect(archiveRequests).toBe(0);
});

test('favorite detail links do not trigger the playable row', async ({page}) => {
  let playbackRequests = 0;
  page.on('request', request => { if (request.url().includes('/playback-queue')) playbackRequests++; });
  await page.route('**/api/users/*/favorites/*/detail-items?**', route => route.fulfill({json:{success:true, data:{
    items:[{bvid:bv,title:'链接测试视频',upperName:'测试UP',upperMid:163637592,playback:{available:true,partCount:1}}], page:1,hasMore:false,
  }}}));
  await page.goto('/?page=accounts');
  await navigate(page, 'accounts');
  await (await revealControl(page, page.locator('[data-action="favorite_detail"]').first())).click();
  await openExternal(page, page.locator('#videoGrid .bilibili-video-link'), true);
  await openExternal(page, page.locator('#videoGrid .bilibili-profile-link'), true, /^https:\/\/space\.bilibili\.com\/163637592$/);
  expect(playbackRequests).toBe(0);
});

test('overview separates the UP homepage from subscription management', async ({page}) => {
  await page.goto('/?page=overview');
  const row = page.locator('.workspace-source-row').filter({hasText:'老师好我叫何同学'});
  await expect(row.locator('button a')).toHaveCount(0);
  await openExternal(page, row.locator('.bilibili-profile-link'), true, /^https:\/\/space\.bilibili\.com\/163637592$/);
  await expect(page.locator('#upWorkspaceModal')).not.toHaveClass(/active/);
  await expect(page).toHaveURL(/page=overview/);
  await row.getByRole('button', {name:'管理 老师好我叫何同学 的订阅'}).click();
  await expect(page.locator('#upWorkspaceModal')).toHaveClass(/active/);
  await openExternal(page, page.locator('#upWorkspaceTitle .bilibili-profile-link'), false, /^https:\/\/space\.bilibili\.com\/163637592$/);
});

test('creator discovery homepage links do not select a subscription', async ({page}) => {
  await page.goto('/?page=subscriptions');
  await page.locator('#upAddBtn').click();
  const person = page.locator('.up-person').filter({hasText:'山野观察员'});
  await expect(person.locator('input')).not.toBeChecked();
  await openExternal(page, person.locator('.bilibili-profile-link'), false, /^https:\/\/space\.bilibili\.com\/[1-9][0-9]*$/);
  await expect(person.locator('input')).not.toBeChecked();
  await expect(page.locator('#upPickedCount')).toHaveText('已选 0 位 UP');
});
