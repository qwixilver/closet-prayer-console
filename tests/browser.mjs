import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fileId, responses } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CP_PLAYWRIGHT_PATH || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'test-results');
const mockDist = resolve(output, 'mock-dist');
assert.ok(mockDist.startsWith(root + sep));
await mkdir(output, { recursive: true });
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const children = [];
let browser;
function runVite(args, env = process.env) {
  const child = spawn(process.execPath, [vite, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', value => { log += value; });
  child.stderr.on('data', value => { log += value; });
  return { child, done: new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Vite failed (${code}): ${log}`)));
  }) };
}
async function ready(url) {
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch(url)).ok) return; } catch { /* Wait for our test server. */ }
    await delay(100);
  }
  throw new Error(`Test server did not start: ${url}`);
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Horizontal overflow');
}

async function mockContext(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const state = { apiCalls: [], viewer: false, denyRefresh: false, delayValues: false, pending: null };
  const data = responses();
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'accounts.google.com' && url.pathname === '/gsi/client') {
      const script = `window.google = { accounts: { oauth2: { initTokenClient(config) {
        return { requestAccessToken() { setTimeout(() => config.callback({ access_token: 'test-only-token',
          scope: ${JSON.stringify(options.denyScope ? 'openid' : 'openid https://www.googleapis.com/auth/drive.file')}, expires_in: 3600 }), 0); } };
      } } } };`;
      return route.fulfill({ contentType: 'application/javascript', body: script });
    }
    if (url.hostname === 'apis.google.com') {
      const script = `window.gapi = { load(_name, config) {
        class View { setMode() { return this; } setMimeTypes() { return this; } }
        class Builder {
          addView() { return this; } setTitle() { return this; } setOAuthToken() { return this; }
          setDeveloperKey() { return this; } setAppId() { return this; } setOrigin() { return this; }
          setCallback(callback) { this.callback = callback; return this; }
          build() {
            let dialog;
            return {
              dispose() {
                if (${Boolean(options.disposeThrows)}) throw new Error('PRIVATE SDK ERROR');
                dialog?.remove();
              },
              setVisible: visible => {
                if (!visible) { dialog?.remove(); return; }
                dialog = document.createElement('dialog');
                dialog.setAttribute('aria-label', 'Test Google Picker');
                const select = document.createElement('button');
                select.textContent = 'Confirm test spreadsheet';
                select.onclick = () => {
                  if (!${Boolean(options.silentSelection)}) this.callback({ action: 'picked', docs: [{ id: '${fileId}' }] });
                };
                const cancel = document.createElement('button');
                cancel.textContent = 'Cancel test picker';
                cancel.onclick = () => this.callback({ action: 'cancel' });
                dialog.append(select, cancel);
                document.body.append(dialog);
                dialog.showModal();
                setTimeout(() => this.callback({ action: 'loaded' }), 0);
              },
            };
          }
        }
        window.google.picker = { DocsView: View, PickerBuilder: Builder, ViewId: { SPREADSHEETS: 'spreadsheets' },
          DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'picked', CANCEL: 'cancel', ERROR: 'error' },
          Response: { ACTION: 'action', DOCUMENTS: 'docs' }, Document: { ID: 'id' } };
        config.callback();
      } };`;
      return route.fulfill({ contentType: 'application/javascript', body: script });
    }
    state.apiCalls.push({ url: url.href, method: route.request().method() });
    assert.equal(route.request().headers().authorization, 'Bearer test-only-token');
    assert.equal(route.request().method(), 'GET', 'Console made a write request');
    let body;
    if (url.hostname === 'openidconnect.googleapis.com') body = { sub: 'test', email: 'admin@example.invalid', email_verified: true, name: 'Test Admin' };
    else if (url.hostname === 'www.googleapis.com') {
      if (state.denyRefresh) return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
      body = { ...data[0], capabilities: { canEdit: !state.viewer } };
    } else if (url.hostname === 'sheets.googleapis.com') {
      if (url.pathname.endsWith('values:batchGet')) {
        body = data[2];
        if (state.delayValues) await new Promise(resolve => { state.pending = resolve; });
      } else body = data[1];
    } else throw new Error(`Unexpected external request: ${url.origin}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:4176/');
  return { page, context, state, errors };
}
async function connectAndChoose(page) {
  await page.getByRole('button', { name: 'Connect Google account' }).click();
  await page.getByRole('button', { name: 'Choose a spreadsheet' }).click();
  await page.getByRole('dialog', { name: 'Test Google Picker' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Example Church Test Group' }).count(), 0);
  await page.getByRole('button', { name: 'Confirm test spreadsheet' }).click();
}

try {
  const build = runVite(['build', '--outDir', mockDist], { ...process.env,
    VITE_GOOGLE_CLIENT_ID: '123456789-test.apps.googleusercontent.com',
    VITE_GOOGLE_API_KEY: 'test-only-restricted-key-not-a-credential',
    VITE_GOOGLE_PROJECT_NUMBER: '123456789' });
  await build.done;
  const server = runVite(['preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort']);
  const mockServer = runVite(['preview', '--outDir', mockDist, '--host', '127.0.0.1', '--port', '4176', '--strictPort']);
  server.done.catch(() => {}); mockServer.done.catch(() => {});
  await ready('http://localhost:4175/'); await ready('http://localhost:4176/');
  assert.match(await (await fetch('http://localhost:4175/LICENSE.txt')).text(), /GNU GENERAL PUBLIC LICENSE/);
  assert.match(await (await fetch('http://localhost:4175/THIRD_PARTY_NOTICES.txt')).text(), /Meta Platforms/);
  browser = await chromium.launch({ channel: 'msedge', headless: true });

  const setupPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const external = [];
  await setupPage.route('https://**/*', route => { external.push(route.request().url()); return route.abort(); });
  await setupPage.goto('http://localhost:4175/');
  await setupPage.getByRole('heading', { name: 'Google setup required' }).waitFor();
  await noOverflow(setupPage);
  await setupPage.screenshot({ path: resolve(output, 'console-desktop.png'), fullPage: true, animations: 'disabled' });
  await setupPage.setViewportSize({ width: 360, height: 800 });
  await noOverflow(setupPage);
  await setupPage.screenshot({ path: resolve(output, 'console-mobile.png'), fullPage: true, animations: 'disabled' });
  await setupPage.getByRole('link', { name: 'Set up the Google connection' }).click();
  await setupPage.getByRole('heading', { name: 'Set up the Google connection' }).waitFor();
  await noOverflow(setupPage);
  assert.equal(await setupPage.locator('h2').count(), 9);
  await setupPage.goto('http://localhost:4175/privacy.html');
  await noOverflow(setupPage);
  assert.deepEqual(external, [], 'Unconfigured console should not contact Google');
  await setupPage.close();
  console.log('PASS: unconfigured state, static guide/privacy, no external calls, desktop/mobile layout');

  const { page, context, state, errors } = await mockContext();
  await connectAndChoose(page);
  await page.getByRole('heading', { name: 'Example Church Test Group' }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Test Google Picker' }).count(), 0);
  assert.ok(await page.getByText('Administrator-only contact: private-test@example.invalid').isVisible());
  assert.equal(await page.getByRole('button', { name: 'Approve submissions' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Prayers 1' }).click();
  await page.getByRole('heading', { name: 'A sample prayer for testing' }).waitFor();
  assert.equal(await page.getByText('Sharing permitted', { exact: true }).count(), 0);
  await page.getByRole('searchbox').fill('no-such-record');
  await page.getByRole('heading', { name: 'No matching records' }).waitFor();
  await page.getByRole('searchbox').fill('');
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    const dimensions = await page.locator('.prayer-card').evaluate(card => ({ card: card.clientWidth, text: card.querySelector('.description').clientWidth }));
    assert.ok(dimensions.text > dimensions.card * .85, `Description squeezed at ${width}px`);
  }
  await page.screenshot({ path: resolve(output, 'dashboard-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: resolve(output, 'dashboard-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  state.denyRefresh = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Google denied access' }).waitFor();
  assert.equal(await page.getByText('A sample prayer for testing').count(), 0);
  state.denyRefresh = false; state.viewer = true;
  await page.getByRole('button', { name: 'Choose a spreadsheet' }).click();
  await page.getByRole('button', { name: 'Confirm test spreadsheet' }).click();
  await page.getByRole('alert').filter({ hasText: 'Editor permission' }).waitFor();
  state.viewer = false; state.delayValues = true;
  await page.getByRole('button', { name: 'Choose a spreadsheet' }).click();
  await page.getByRole('button', { name: 'Confirm test spreadsheet' }).click();
  for (let n = 0; !state.pending && n < 100; n++) await delay(20);
  assert.ok(state.pending, 'Expected a delayed response');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  state.pending();
  await page.getByRole('button', { name: 'Connect Google account' }).waitFor();
  await delay(200);
  assert.equal(await page.getByRole('heading', { name: 'Example Church Test Group' }).count(), 0);
  assert.equal(await page.getByText('admin@example.invalid').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS: group read/search, privacy labels, Editor check, rejected refresh, sign-out race, no storage/writes, responsive descriptions');

  const denied = await mockContext({ denyScope: true });
  await denied.page.getByRole('button', { name: 'Connect Google account' }).click();
  await denied.page.getByRole('alert').filter({ hasText: 'File access was not granted' }).waitFor();
  assert.equal(denied.state.apiCalls.length, 0);
  await denied.context.close();
  console.log('PASS: denied scope does not read account or prayer data');

  const expiry = await mockContext();
  await expiry.page.clock.install();
  await connectAndChoose(expiry.page);
  await expiry.page.getByRole('heading', { name: 'Example Church Test Group' }).waitFor();
  await expiry.page.clock.fastForward(3600000);
  await expiry.page.getByRole('alert').filter({ hasText: 'session expired' }).waitFor();
  assert.equal(await expiry.page.getByText('A fictional inbox submission').count(), 0);
  assert.equal(await expiry.page.getByText('admin@example.invalid').count(), 0);
  await expiry.context.close();
  console.log('PASS: session expiry clears profile and private records');

  const cleanup = await mockContext({ disposeThrows: true });
  await connectAndChoose(cleanup.page);
  await cleanup.page.getByRole('heading', { name: 'Example Church Test Group' }).waitFor();
  assert.equal(await cleanup.page.getByRole('dialog', { name: 'Test Google Picker' }).count(), 0);
  await cleanup.page.getByText('Connection diagnostics', { exact: true }).click();
  const cleanupReport = await cleanup.page.getByRole('textbox', { name: 'Connection diagnostics report' }).inputValue();
  assert.match(cleanupReport, /picker-selection-received/);
  assert.match(cleanupReport, /picker-cleanup-warning/);
  assert.match(cleanupReport, /group-loaded/);
  assert.doesNotMatch(cleanupReport, /PRIVATE|example.invalid|test-only-token|test_spreadsheet/);
  assert.deepEqual(cleanup.errors, []);
  await cleanup.context.close();
  console.log('PASS: cleanup failure does not block group loading; diagnostic report contains no private data');

  const silent = await mockContext({ silentSelection: true });
  await silent.page.clock.install();
  await connectAndChoose(silent.page);
  await silent.page.clock.fastForward(46000);
  assert.equal(silent.state.apiCalls.length, 1, 'No file read before Google confirms selection');
  await silent.page.getByRole('button', { name: 'Cancel test picker' }).click();
  await silent.page.getByRole('dialog', { name: 'Test Google Picker' }).waitFor({ state: 'hidden' });
  await silent.page.getByText('Connection diagnostics', { exact: true }).click();
  const silentReport = await silent.page.getByRole('textbox', { name: 'Connection diagnostics report' }).inputValue();
  assert.match(silentReport, /picker-waiting/);
  assert.match(silentReport, /picker-cancelled/);
  assert.doesNotMatch(silentReport, /picker-selection-received|group-reading|group-loaded/);
  assert.equal(await silent.page.getByRole('button', { name: 'Choose a spreadsheet' }).isEnabled(), true);
  assert.deepEqual(silent.errors, []);
  await silent.context.close();
  console.log('PASS: missing selection callback is diagnosable and cancellable without reading files');
} finally {
  await browser?.close();
  for (const child of children) if (child.exitCode === null) child.kill();
}
