import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

// Explicit opt-in: run only against the synthetic test installation.
if (process.env.FEVER_BROWSER_TESTS !== '1') throw new Error('Set FEVER_BROWSER_TESTS=1 for the isolated test environment.');
const base = new URL(process.env.FEVER_BROWSER_BASE_URL ?? 'http://localhost:3000');
const hostedOrigin = process.env.FEVER_BROWSER_HOSTED_ORIGIN;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Browser base URL must be an HTTP(S) installation URL without credentials, query, or fragment.');
if (!local && (base.protocol !== 'https:' || hostedOrigin !== base.origin)) throw new Error('Hosted browser tests require FEVER_BROWSER_HOSTED_ORIGIN to match the HTTPS base origin exactly.');
const credentials = JSON.parse(await readFile(process.env.FEVER_BROWSER_CREDENTIALS_FILE, 'utf8'));
const output = resolve(process.env.FEVER_BROWSER_OUTPUT ?? resolve(tmpdir(), 'feedafever-browser-smoke'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.FEVER_BROWSER_CHANNEL ? { channel: process.env.FEVER_BROWSER_CHANNEL } : {}) });
const failures = [], steps = [], pageErrors = [], assetFailures = [], itemDetailRequests = [];
const path = (value) => `${base.origin}${base.pathname.replace(/\/$/, '')}${value}`;
const capture = async (page, name) => {
  // Capture settled UI, while leaving infinite progress/spinner animations alone.
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    await Promise.all([...document.querySelectorAll('i.favicon img')].map(image => image.decode().catch(() => {})));
  });
  return page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
};
const track = (page) => {
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => { if (/\/api\/items\/\d+(?:\?|$)/.test(request.url())) itemDetailRequests.push(request.url()); });
  page.on('response', (response) => { if (response.status() >= 400 && /\/(?:fever\/|api\/favicons\/)/.test(response.url())) assetFailures.push({ url: response.url(), status: response.status() }); });
};
const step = async (name, run) => { try { await run(); steps.push({ name, passed: true }); console.log(`PASS ${name}`); } catch (error) { failures.push({ name, message: String(error) }); console.error(`FAIL ${name}: ${error}`); } };
try {
  const extraHTTPHeaders = process.env.FEVER_BROWSER_HEADERS_FILE ? JSON.parse(await readFile(process.env.FEVER_BROWSER_HEADERS_FILE, 'utf8')) : {};
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders });
  const page = await context.newPage(); track(page);
  await step('branded login and real credential authentication', async () => {
    await page.goto(path('/login'));
    await page.getByLabel('Email', { exact: true }).fill(credentials.email);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await capture(page, 'login');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL((url) => url.origin === base.origin && url.pathname.replace(/\/$/, '') === base.pathname.replace(/\/$/, ''), { timeout: 60_000 });
    await page.locator('.fever-desktop').waitFor({ timeout: 60_000 });
    assert.match(await page.title(), /^Fever/);
    if (process.env.FEVER_BROWSER_STORAGE_FILE) {
      await context.storageState({ path: process.env.FEVER_BROWSER_STORAGE_FILE });
      await chmod(process.env.FEVER_BROWSER_STORAGE_FILE, 0o600);
    }
  });
  await step('desktop populated reader, identity, unique navigation and card geometry', async () => {
    await page.goto(path('/?section=kindling&showFeeds=1&showRead=1'));
    await page.locator('article.box.item').first().waitFor({ timeout: 60_000 });
    assert.equal(await page.locator('#groups #group-0').count(), 1);
    assert.equal(await page.locator('#groups').getByRole('link', { name: /^Kindling/ }).count(), 1);
    const heights = await page.locator('article#item-1, article#item-2, article#item-3').evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().height));
    assert.ok(heights.length >= 3 && heights.every((height) => height >= 60 && height < 700), `Unexpected fixture card heights: ${heights}`);
    assert.equal(await page.locator('.item.saved').count(), 1);
    const headerHeights = await page.locator('.item .meta h2').evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().height));
    assert.ok(headerHeights.every((height) => height === 30), `Article header sprite height must match PHP: ${headerHeights}`);
    await page.getByText('Loading the full article…', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 });
    assert.equal(itemDetailRequests.length, 0, 'List payloads already include full HTML, including valid empty content');
    const nodeFeed = page.locator('#feeds').getByRole('link', { name: /^Node.js \(test feed\)/ });
    if (await nodeFeed.count()) {
      assert.equal(await nodeFeed.evaluate((el) => el.closest('li')?.classList.contains('has-error')), false, 'A successful capped feed must not be styled as failed');
      assert.match(await nodeFeed.getAttribute('title'), /last refresh reported:/);
    }
    await capture(page, 'desktop-reader');
    await page.goto(path('/?section=kindling&showFeeds=1&showRead=0'));
    await page.locator('article.item.unread, article.item.new').first().waitFor({ timeout: 60_000 });
    await capture(page, 'desktop-unread');
  });
  await step('preference tabs, dialog focus containment and Escape', async () => {
    await page.goto(path('/?section=kindling&showFeeds=1&showRead=1&dialog=preferences'));
    const dialog = page.getByRole('dialog'); await dialog.waitFor({ timeout: 60_000 });
    for (const label of ['Behavior', 'Display', 'Refreshing', 'Sharing', 'Login']) {
      const tab = dialog.getByRole('tab', { name: label, exact: true });
      if (await tab.count()) await tab.click(); else await dialog.getByRole('button', { name: label, exact: true }).click();
    }
    await page.keyboard.press('Tab');
    assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)), 'Focus left the dialog');
    await capture(page, 'preferences');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });
  await step('support pages render without application errors', async () => {
    for (const route of ['/shortcuts', '/extras', '/blacklist', '/diagnostics', '/feedlet', '/subscribe', '/maintenance']) {
      const response = await page.goto(path(route)); assert.equal(response.status(), 200, route);
      await page.locator('h1').first().waitFor({ timeout: 60_000 });
    }
    await page.goto(path('/shortcuts'));
    await page.getByText('Checking your session…', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 });
    await page.getByText('Loading your sharing services…', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 });
    await page.getByText('No sharing service has a shortcut key.', { exact: false })
      .or(page.locator('table.fp-shortcuts caption').filter({ hasText: 'Send to' }))
      .waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await page.getByRole('heading', { name: 'Send-to shortcuts unavailable' }).count(), 0);
    await capture(page, 'shortcuts');
  });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, extraHTTPHeaders, storageState: await context.storageState() });
  const phone = await mobile.newPage(); track(phone);
  await step('mobile groups, feeds, items, article and browser Back', async () => {
    await phone.goto(path('/'));
    await phone.getByRole('button', { name: /^Kindling/ }).waitFor({ timeout: 60_000 });
    assert.equal(await phone.locator('#group-0').count(), 1);
    await capture(phone, 'mobile-groups');
    await phone.getByRole('button', { name: /^Kindling/ }).click();
    await phone.getByRole('button', { name: /^Example Feed/ }).waitFor({ timeout: 60_000 });
    await capture(phone, 'mobile-feeds');
    const globeOffsets = await phone.locator('#feeds .list button i.favicon.icon i').evaluateAll(icons => icons.map(icon => {
      const glyph = icon.getBoundingClientRect(), row = icon.closest('button').getBoundingClientRect();
      return (glyph.top + glyph.height / 2) - (row.top + row.height / 2);
    }));
    assert.ok(globeOffsets.length > 0 && globeOffsets.every(offset => Math.abs(offset) < 1), `Generic mobile globe must be vertically centered: ${globeOffsets}`);
    // Hold the selected scope response so the loading state cannot pass on rows
    // left behind from Kindling. This previously captured Node.js rows as Example Feed.
    let releaseScope;
    const heldScope = new Promise((resolve) => { releaseScope = resolve; });
    let signalScope;
    const requestedScope = new Promise((resolve) => { signalScope = resolve; });
    const holdSelectedScope = async (route) => {
      if (new URL(route.request().url()).searchParams.get('feedId') === '2') {
        signalScope(); await heldScope;
      }
      await route.continue();
    };
    await phone.route('**/api/reader?*', holdSelectedScope);
    await phone.getByRole('button', { name: /^Example Feed/ }).click();
    let scopeTimeout;
    try {
      await Promise.race([requestedScope, new Promise((_, reject) => {
        scopeTimeout = setTimeout(() => reject(new Error('Selected feed did not request its reader scope')), 15_000);
      })]);
      await phone.locator('#items .header .back.spinning').waitFor({ timeout: 15_000 });
      assert.equal(await phone.locator('#items ul.list li').count(), 0, 'A new scope must not expose old-scope rows while loading');
    } finally { clearTimeout(scopeTimeout); releaseScope(); }
    await phone.locator('#items ul.list li').first().waitFor({ timeout: 60_000 });
    await phone.unroute('**/api/reader?*', holdSelectedScope);
    assert.ok((await phone.locator('#items ul.list li > button').evaluateAll((els) => els.map((el) => el.classList.contains('feed-2')))).every(Boolean), 'Every Example Feed row must belong to feed 2');
    await capture(phone, 'mobile-items');
    await phone.locator('#items ul.list li button').first().click();
    await phone.locator('#item .item-content').waitFor({ timeout: 60_000 });
    const header = await phone.locator('#item .header').evaluate((el) => {
      const back = el.querySelector('.left .btn').getBoundingClientRect();
      const title = el.querySelector('.title'); const rect = title.getBoundingClientRect();
      return { backRight: back.right, titleContentLeft: rect.left + parseFloat(getComputedStyle(title).paddingLeft) };
    });
    assert.ok(header.backRight + 4 <= header.titleContentLeft, `Back button overlaps article title: ${JSON.stringify(header)}`);
    await capture(phone, 'mobile-article');
    await phone.goBack();
    await phone.locator('#items ul.list li').first().waitFor({ timeout: 60_000 });
  });
  assert.deepEqual(assetFailures, [], 'Original artwork failed to load');
  assert.deepEqual(pageErrors, [], 'Browser application errors');
} catch (error) { failures.push({ name: 'browser harness', message: String(error) }); }
finally {
  await browser.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ node: process.version, base: base.href, steps, failures, pageErrors, assetFailures, itemDetailRequests }, null, 2));
}
if (failures.length) process.exitCode = 1;
