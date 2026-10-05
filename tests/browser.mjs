import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fileId, groupId, endpoint, responses, managedResponses } from './fixtures.mjs';

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
  const state = { apiCalls: [], viewer: false, denyRefresh: false, delayValues: false, pending: null, loseProcess: false, conflict: false, mismatch: false };
  const data = structuredClone(options.managed ? managedResponses() : responses());
  state.data = data;
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'docs.google.com' && url.pathname === '/picker') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Test picker frame</p><script>parent.postMessage("PRIVATE MESSAGE CONTENT", "http://localhost:4176");</script>' });
    }
    if (url.hostname === 'accounts.google.com' && url.pathname === '/gsi/client') {
      const script = `window.google = { accounts: { oauth2: { initTokenClient(config) {
        return { requestAccessToken() { setTimeout(() => config.callback({ access_token: 'test-only-token',
          scope: ${JSON.stringify(options.denyScope ? 'openid' : 'openid https://www.googleapis.com/auth/drive.file')}, expires_in: 3600 }), 0); } };
      } } } };`;
      return route.fulfill({ contentType: 'application/javascript', body: script });
    }
    if (url.hostname === 'apis.google.com') {
      if (options.realSdk) return route.continue();
      const script = `window.gapi = { load(_name, config) {
        class View { setMode() { return this; } setMimeTypes() { return this; } }
        class Builder {
          addView() { return this; } setTitle() { return this; } setOAuthToken() { return this; }
          setDeveloperKey() { return this; } setAppId() { return this; } setOrigin() { return this; }
          setCallback(callback) { this.callback = callback; return this; }
          build() {
            window.testPickerCallback = this.callback;
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
                cancel.onclick = () => { if (!${Boolean(options.noCallbacks)}) this.callback({ action: 'cancel' }); };
                const frame = document.createElement('iframe');
                frame.src = 'https://docs.google.com/picker';
                frame.title = 'Test picker transport';
                dialog.append(select, cancel, frame);
                document.body.append(dialog);
                dialog.showModal();
                if (!${Boolean(options.noCallbacks)}) setTimeout(() => this.callback({ action: 'loaded' }), 0);
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
    if (url.href === endpoint) {
      assert.equal(route.request().headers().authorization, undefined);
      assert.equal(route.request().method(), 'POST');
      const request = route.request().postDataJSON();
      assert.equal(request.token, 'S'.repeat(43));
      assert.equal(request.command, undefined);
      const body = { protocol: 'cp-group', version: 1, ok: true, group: { id: groupId }, consoleVersion: 1, sheetId: state.mismatch ? 'different_sheet_123456' : fileId };
      if (request.action === 'console-process') {
        const row = data[2].valueRanges[3].values.find(row => row[0] === request.requestId);
        assert.ok(row);
        if (row[3] === 'pending') {
          const command = JSON.parse(row[2]);
          row[3] = state.conflict ? 'conflict' : 'applied';
          row[4] = new Date().toISOString();
          if (!state.conflict) {
            const requests = data[2].valueRanges[0].values;
            const submission = data[2].valueRanges[1].values.find(row => row[0] === command.id);
            const previous = requests.find(row => row[0] === command.id);
            if (command.type === 'approve' || command.type === 'decline') submission[7] = command.type === 'approve' ? 'approved' : 'declined';
            if (command.type !== 'decline') {
              const p = command.prayer;
              const values = [command.id, p.publication, p.visibility, previous?.[3] || submission?.[6] || p.consent, p.title, p.description, p.requestor, p.requestedAt, p.status];
              if (previous) previous.splice(0, previous.length, ...values); else requests.push(values);
            }
          }
        }
        body.outcome = row[3];
        if (state.loseProcess) { state.loseProcess = false; return route.abort('failed'); }
      } else assert.equal(request.action, 'console-info');
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    }
    assert.equal(route.request().headers().authorization, 'Bearer test-only-token');
    if (options.managed && url.pathname.endsWith('/values/ConsoleCommands!A:E:append')) {
      assert.equal(route.request().method(), 'POST');
      assert.equal(url.searchParams.get('valueInputOption'), 'RAW');
      data[2].valueRanges[3].values.push(...route.request().postDataJSON().values);
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    }
    assert.equal(route.request().method(), 'GET', 'Unexpected write request');
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
  await setupPage.getByRole('heading', { name: 'Enable management for an existing group' }).waitFor();
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
  assert.ok(await page.getByText('Script upgrade required for editing.').isVisible());
  assert.equal(await page.getByRole('button', { name: 'Review and approve' }).count(), 0);
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

  const managed = await mockContext({ managed: true });
  const mp = managed.page;
  await connectAndChoose(mp);
  await mp.getByRole('button', { name: 'Review and approve' }).click();
  assert.equal(await mp.getByLabel('Sharing', { exact: true }).locator('option[value="shareable"]').evaluate(option => option.disabled), true);
  await mp.getByRole('button', { name: 'Approve and publish', exact: true }).click();
  await mp.getByRole('status').filter({ hasText: 'Change applied' }).waitFor();
  assert.equal(managed.state.data[2].valueRanges[1].values[1][7], 'approved');
  assert.equal(managed.state.data[2].valueRanges[0].values.length, 3);
  assert.doesNotMatch(JSON.stringify(managed.state.data[2].valueRanges[0]), /private-test@/);
  await mp.getByRole('button', { name: 'New prayer', exact: true }).click();
  await mp.getByLabel('Prayer title', { exact: true }).fill('New console prayer');
  await mp.getByLabel('Prayer request', { exact: true }).fill('A fictional request that uses the full card width.');
  await mp.getByLabel('Publication', { exact: true }).selectOption('published');
  await mp.getByRole('checkbox', { name: /I have permission/ }).check();
  await mp.getByLabel('Sharing', { exact: true }).selectOption('shareable');
  await mp.setViewportSize({ width: 360, height: 800 });
  await noOverflow(mp);
  await mp.screenshot({ path: resolve(output, 'prayer-editor-mobile.png'), fullPage: true, animations: 'disabled' });
  managed.state.loseProcess = true;
  await mp.getByRole('button', { name: 'Save prayer', exact: true }).click();
  await mp.getByRole('alert').filter({ hasText: 'result is uncertain' }).waitFor();
  const commandCount = managed.state.data[2].valueRanges[3].values.length;
  await mp.getByRole('button', { name: 'Check / retry this save', exact: true }).click();
  await mp.getByRole('status').filter({ hasText: 'Change applied' }).waitFor();
  assert.equal(managed.state.data[2].valueRanges[3].values.length, commandCount);
  await mp.getByRole('button', { name: 'Prayers 3' }).click();
  const created = mp.locator('article').filter({ has: mp.getByRole('heading', { name: 'New console prayer' }) });
  await created.getByRole('button', { name: 'Edit prayer' }).click();
  await mp.getByLabel('Status', { exact: true }).selectOption('answered');
  await mp.getByLabel('Publication', { exact: true }).selectOption('withdrawn');
  await mp.getByRole('button', { name: 'Save prayer', exact: true }).click();
  await created.getByText('withdrawn / answered', { exact: true }).waitFor();
  await created.getByRole('button', { name: 'Edit prayer' }).click();
  await mp.getByLabel('Prayer title', { exact: true }).fill('Stale title');
  managed.state.conflict = true;
  await mp.getByRole('button', { name: 'Save prayer', exact: true }).click();
  await mp.getByRole('alert').filter({ hasText: 'record changed' }).waitFor();
  assert.equal(managed.state.data[2].valueRanges[0].values.at(-1)[4], 'New console prayer');
  await mp.getByRole('button', { name: 'Close editor' }).click();
  managed.state.conflict = false;
  await mp.getByRole('button', { name: 'Verify service and show embed' }).click();
  const embed = await mp.getByLabel('Church website iframe').inputValue();
  assert.match(embed, /#group=CPG1\.s\./);
  assert.doesNotMatch(embed, /CPG1\.m\.|test-only-token|private-test/);
  assert.equal((await mp.getByLabel('Public submission link').inputValue()), new URL(embed.match(/src="([^"]+)"/)[1]).href);
  await noOverflow(mp);
  await mp.screenshot({ path: resolve(output, 'management-mobile.png'), fullPage: true, animations: 'disabled' });
  await mp.setViewportSize({ width: 1280, height: 900 });
  await noOverflow(mp);
  await mp.screenshot({ path: resolve(output, 'management-desktop.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(await mp.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.deepEqual(managed.errors, []);
  await managed.context.close();

  const declined = await mockContext({ managed: true });
  await connectAndChoose(declined.page);
  await declined.page.getByRole('button', { name: 'Decline', exact: true }).click();
  await declined.page.getByRole('button', { name: 'Confirm decline' }).click();
  await declined.page.getByRole('status').filter({ hasText: 'Change applied' }).waitFor();
  assert.equal(declined.state.data[2].valueRanges[1].values[1][7], 'declined');
  assert.equal(declined.state.data[2].valueRanges[0].values.length, 2);
  declined.state.mismatch = true;
  await declined.page.getByRole('button', { name: 'Verify service and show embed' }).click();
  await declined.page.getByRole('alert').filter({ hasText: 'does not belong' }).waitFor();
  assert.equal(await declined.page.getByLabel('Church website iframe').count(), 0);
  await declined.context.close();

  const pending = await mockContext({ managed: true });
  await connectAndChoose(pending.page);
  await pending.page.getByRole('button', { name: 'New prayer', exact: true }).click();
  await pending.page.getByLabel('Prayer title', { exact: true }).fill('Pending prayer');
  // Lose the response after Google accepts the append, before the service runs.
  await pending.context.route('https://sheets.googleapis.com/**/values/ConsoleCommands!A:E:append?*', async route => {
    pending.state.data[2].valueRanges[3].values.push(...route.request().postDataJSON().values);
    await route.abort('failed');
  });
  await pending.page.getByRole('button', { name: 'Save prayer', exact: true }).click();
  await pending.page.getByRole('alert').filter({ hasText: 'result is uncertain' }).waitFor();
  await pending.page.getByRole('button', { name: 'Close editor' }).click();
  await pending.page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await pending.page.getByText('Change history (1)', { exact: true }).click();
  await pending.page.getByRole('button', { name: 'Check / finish pending change' }).click();
  await pending.page.getByRole('status').filter({ hasText: 'Change applied' }).waitFor();
  assert.equal(pending.state.data[2].valueRanges[3].values.length, 2);
  assert.equal(pending.state.data[2].valueRanges[0].values.at(-1)[4], 'Pending prayer');
  pending.state.denyRefresh = true;
  await pending.page.getByRole('button', { name: 'New prayer', exact: true }).click();
  await pending.page.getByLabel('Prayer title', { exact: true }).fill('Must not be written');
  await pending.page.getByRole('button', { name: 'Save prayer', exact: true }).click();
  await pending.page.getByRole('alert').filter({ hasText: 'Google denied access' }).waitFor();
  assert.equal(await pending.page.getByRole('heading', { name: 'Example Church Test Group' }).count(), 0);
  assert.equal(pending.state.data[2].valueRanges[3].values.length, 2);
  await pending.context.close();
  console.log('PASS: console approval, create/edit/withdraw, consent, contact isolation, interrupted-save retry, stale edits, decline, verified iframe links, and mobile editor layout');

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
  await silent.page.getByRole('button', { name: 'Keep choosing', exact: true }).click();
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

  const stalled = await mockContext({ silentSelection: true, noCallbacks: true });
  await stalled.page.clock.install();
  await stalled.page.setViewportSize({ width: 360, height: 800 });
  await connectAndChoose(stalled.page);
  await stalled.page.getByRole('button', { name: 'Cancel test picker' }).click();
  await stalled.page.clock.fastForward(46000);
  await stalled.page.getByRole('dialog', { name: 'Still choosing a spreadsheet?' }).waitFor();
  const helpTabPromise = stalled.context.waitForEvent('page');
  await stalled.page.getByRole('dialog', { name: 'Still choosing a spreadsheet?' }).getByRole('link', { name: 'Brave cookie help' }).click();
  const helpTab = await helpTabPromise;
  await helpTab.getByRole('heading', { name: 'Brave: picker stalls with cookies blocked' }).waitFor();
  assert.match(helpTab.url(), /\/setup\.html#brave-cookies$/);
  await helpTab.setViewportSize({ width: 360, height: 800 });
  await noOverflow(helpTab);
  await helpTab.close();
  await stalled.page.bringToFront();
  await noOverflow(stalled.page);
  await stalled.page.screenshot({ path: resolve(output, 'picker-recovery-mobile.png'), fullPage: true, animations: 'disabled' });
  await stalled.page.getByRole('button', { name: 'Keep choosing', exact: true }).click();
  await stalled.page.clock.fastForward(46000);
  await stalled.page.getByRole('button', { name: 'Close picker and show diagnostics' }).click();
  await stalled.page.getByRole('dialog', { name: 'Test Google Picker' }).waitFor({ state: 'hidden' });
  const stalledReport = stalled.page.getByRole('textbox', { name: 'Connection diagnostics report' });
  await stalledReport.waitFor({ state: 'visible' });
  assert.equal(await stalledReport.evaluate(element => element === document.activeElement), true);
  assert.match(await stalledReport.inputValue(), /picker-closed-by-user/);
  assert.doesNotMatch(await stalledReport.inputValue(), /picker-loaded|picker-selection-received|PRIVATE|example.invalid/);
  assert.equal(await stalled.page.getByRole('button', { name: 'Choose a spreadsheet' }).isEnabled(), true);
  await stalled.page.evaluate(id => window.testPickerCallback({ action: 'picked', docs: [{ id }] }), fileId);
  await delay(100);
  assert.equal(stalled.state.apiCalls.length, 1, 'Late callback after recovery cannot read a file');
  await stalled.page.getByRole('button', { name: 'Choose a spreadsheet' }).click();
  await stalled.page.evaluate(id => window.testPickerCallback({ action: 'picked', docs: [{ id }] }), fileId);
  await stalled.page.getByRole('heading', { name: 'Example Church Test Group' }).waitFor();
  assert.equal(await stalled.page.getByRole('dialog', { name: 'Still choosing a spreadsheet?' }).count(), 0);
  assert.deepEqual(stalled.errors, []);
  await stalled.context.close();
  console.log('PASS: recovery works above a blocking modal with no callbacks, keeps diagnostics/login, ignores late events, and allows retry');

  if (process.env.CP_LIVE_GOOGLE_SDK === '1') {
    // Load the real public SDK but intercept authentication, Picker content and
    // data reads. This uses no Google account and never exposes real records.
    const live = await mockContext({ realSdk: true });
    await live.page.clock.install();
    await live.page.getByRole('button', { name: 'Connect Google account' }).click();
    await live.page.getByRole('button', { name: 'Choose a spreadsheet' }).click();
    await live.page.locator('.picker-dialog').waitFor();
    await live.page.locator('iframe.picker-dialog-frame').waitFor();
    await live.page.frameLocator('iframe.picker-dialog-frame').getByText('Test picker frame').waitFor();
    await live.page.clock.fastForward(46000);
    await live.page.getByRole('dialog', { name: 'Still choosing a spreadsheet?' }).waitFor();
    for (const width of [1280, 360]) {
      await live.page.setViewportSize({ width, height: 800 });
      const recovery = live.page.getByRole('dialog', { name: 'Still choosing a spreadsheet?' });
      assert.equal(await recovery.evaluate(element => element.closest('[aria-hidden="true"]') === null), true);
      const box = await recovery.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      await live.page.screenshot({ path: resolve(output, `real-picker-recovery-${width}.png`), animations: 'disabled' });
    }
    await live.page.getByRole('button', { name: 'Close picker and show diagnostics' }).click();
    assert.equal(await live.page.locator('.picker-dialog, .picker-dialog-bg').count(), 0);
    const report = await live.page.getByRole('textbox', { name: 'Connection diagnostics report' }).inputValue();
    assert.match(report, /picker-frame-message/);
    assert.match(report, /picker-closed-by-user/);
    assert.doesNotMatch(report, /PRIVATE|picker-selection-received|group-reading/);
    assert.equal(live.state.apiCalls.length, 1, 'No file read without the real SDK selection callback');
    assert.deepEqual(live.errors, []);
    await live.context.close();
    console.log('PASS: recovery above the real Google SDK dialog/overlay, accessibility visibility, frame transport diagnostics, no account or file access');
  }
} finally {
  await browser?.close();
  for (const child of children) if (child.exitCode === null) child.kill();
}
