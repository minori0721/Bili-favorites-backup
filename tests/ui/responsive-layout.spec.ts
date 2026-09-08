import { expect, test } from '@playwright/test';

test('home layout follows available width without horizontal queues or empty account spacing', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Explicit viewport matrix covers this layout.');
  await page.request.post('/__test/reset', { data: { usersMode: 'double' } });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '' }));
  await page.goto('/');
  await expect(page.locator('.queue-board')).toHaveClass(/is-empty/);
  await expect(page.locator('#userList > .user-item')).toHaveCount(2);
  for (const width of [320, 390, 600, 602, 617, 1045, 1188, 1190, 1280]) {
    await page.setViewportSize({ width, height: width === 1045 ? 792 : 620 });
    const layout = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>('.queue-board')!;
      const columns = [...board.querySelectorAll<HTMLElement>('.queue-col')];
      const actions = document.querySelector('.account-actions')!.getBoundingClientRect();
      const users = document.querySelector('#userList')!.getBoundingClientRect();
      const brand = document.querySelector('.app-brand')!.getBoundingClientRect();
      const headerActions = document.querySelector('.header-actions')!.getBoundingClientRect();
      return {
        width: board.clientWidth,
        columns: getComputedStyle(board).gridTemplateColumns.split(' ').length,
        overflow: board.scrollWidth - board.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        heights: columns.map(col => col.getBoundingClientRect().height),
        emptyListOverflows: [...board.querySelectorAll('.queue-list')].some(list => list.scrollHeight > list.clientHeight),
        gap: users.top - actions.bottom,
        singleHeaderRow: Math.abs(brand.top + brand.height / 2 - headerActions.top - headerActions.height / 2) < 2,
      };
    });
    expect(layout.columns, `columns at ${width}`).toBe(layout.width >= 1076 ? 4 : layout.width >= 532 ? 2 : 1);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.pageOverflow).toBeLessThanOrEqual(1);
    expect(layout.heights.every(height => height <= 112)).toBe(true);
    expect(layout.emptyListOverflows).toBe(false);
    expect(layout.gap).toBeCloseTo(16, 0);
    if (width >= 617) expect(layout.singleHeaderRow, `header at ${width}`).toBe(true);
  }
});

test('populated queue keeps bounded vertical lists and equal columns', async ({ page }) => {
  await page.request.post('/__test/reset', { data: { queueBoardMode: 'manual_wait' } });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '' }));
  await page.route('**/api/queue/state', async route => {
    const response = await route.fetch();
    const json = await response.json();
    const item = json.data.uploadPending[0];
    json.data.uploadPending = Array.from({ length: 20 }, (_, index) => ({ ...item, id: `layout-${index}`, bvid: `BVlayout${index}` }));
    await route.fulfill({ json });
  });
  await page.goto('/');
  await expect(page.locator('.queue-card')).toHaveCount(20);
  await expect(page.locator('.queue-board')).not.toHaveClass(/is-empty/);
  const layout = await page.locator('.queue-board').evaluate(board => {
    const columns = [...board.querySelectorAll<HTMLElement>('.queue-col')];
    const list = board.querySelector('.queue-card')!.parentElement!;
    return {
      heights: columns.map(col => col.getBoundingClientRect().height),
      verticalOverflow: list.scrollHeight > list.clientHeight,
      overflowY: getComputedStyle(list).overflowY,
      horizontalOverflow: board.scrollWidth - board.clientWidth,
    };
  });
  expect(new Set(layout.heights).size).toBe(1);
  expect(layout.verticalOverflow).toBe(true);
  expect(layout.overflowY).toBe('auto');
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
});

test('long version labels stay contained and account errors remain visible', async ({ page }) => {
  await page.request.post('/__test/reset', { data: { usersErrorOnce: true } });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '' }));
  await page.route('**/', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(id="versionInfoBtn"[^>]*>)[^<]*/, '$1v2.5.6-dev-very-long-build-version-123456789');
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect(page.locator('#userListStatus')).toBeVisible();
  await expect(page.locator('#userListStatus')).not.toBeEmpty();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.locator('#versionInfoBtn')).toBeVisible();
  await expect(page.locator('#logoutBtn')).toBeVisible();
});
