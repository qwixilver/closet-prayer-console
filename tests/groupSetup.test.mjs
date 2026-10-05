import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSetupService, memberLink, parseSetup, setupGoogle } from '../src/groupSetup.js';
import { requestGoogleSession, SCOPES, SETUP_SCOPES } from '../src/google.js';
import { readGroup } from '../src/groupReader.js';
import { managedResponses } from './fixtures.mjs';
import { setupFixture, setupEmail, setupSheetId, setupScriptId } from './setupFixture.mjs';

const source = await readFile(new URL('../src/service-template/Code.gs', import.meta.url), 'utf8');
const session = { token: 'test-setup-token', expiresAt: Date.now() + 3600000 };
function service(f, extra = {}) { return createSetupService(source, session, { fetchImpl: f.fetchImpl, ...extra }); }

test('guided setup starts private and needs the exact approval receipt before activation', async () => {
  const f = setupFixture(), api = service(f);
  const created = await api.create('Test Church', setupEmail);
  assert.equal(created.phase, 'authorizing');
  assert.equal(f.sheetPayload.sheets.length, 5);
  assert.deepEqual(JSON.parse(f.files.find(file => file.name === 'appsscript').source).webapp, { access: 'MYSELF', executeAs: 'USER_ACCESSING' });
  assert.ok(f.files.some(file => file.name === 'Install'));
  assert.ok(!JSON.stringify(f.files).includes(session.token));
  assert.equal((await api.finish(created, setupEmail)).phase, 'authorizing');
  assert.equal(f.calls.some(call => new URL(call.url).hostname === 'script.google.com'), false);
  f.authorize();
  const ready = await api.finish(created, setupEmail);
  assert.equal(ready.phase, 'ready');
  assert.deepEqual(JSON.parse(f.files.find(file => file.name === 'appsscript').source).webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
  assert.equal(f.files.some(file => file.name === 'Install'), false);
  assert.equal(f.settings.find(row => row[0] === 'groupId')[1], ready.groupId);
  assert.match(memberLink(ready), /#group=CPG1\.m\./);
  assert.equal(memberLink(ready).includes(ready.submissionToken), false);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url === 'https://script.googleapis.com/v1/projects').length, 1);
  assert.equal(parseSetup(f.values, setupSheetId).phase, 'ready');
});

test('an uncertain deployment response resumes the same deployment without creating another', async () => {
  const f = setupFixture(); f.loseDeployment = true;
  const api = service(f);
  await assert.rejects(api.create('Recovery church', setupEmail), /Lost deployment/);
  const known = await api.load(setupSheetId);
  assert.equal(known.phase, 'project-ready');
  const resumed = await api.finish(known, setupEmail);
  assert.equal(resumed.phase, 'authorizing'); assert.equal(f.deployments.length, 1);
});

test('an uncertain project creation is not blindly retried; recovery requires the matching bound project', async () => {
  const f = setupFixture(); f.loseProject = true;
  const api = service(f);
  await assert.rejects(api.create('Recovery church', setupEmail), /Lost project/);
  const known = await api.load(setupSheetId);
  await assert.rejects(api.finish(known, setupEmail), /interrupted/);
  f.parent = 'another_sheet_123456789';
  await assert.rejects(api.finish({ ...known, scriptId: setupScriptId }, setupEmail), /does not belong/);
  f.parent = setupSheetId;
  const resumed = await api.finish({ ...known, scriptId: setupScriptId }, setupEmail);
  assert.equal(resumed.phase, 'authorizing');
  assert.equal(f.calls.filter(call => call.url === 'https://script.googleapis.com/v1/projects').length, 1);
});

test('failed checkpoint retains the known project ID for a same-tab retry', async () => {
  const f = setupFixture(); f.failCheckpoint = true;
  let known;
  const api = service(f, { onCheckpoint: next => { known = next; } });
  await assert.rejects(api.create('Recovery church', setupEmail), /Lost checkpoint/);
  assert.equal(known.scriptId, setupScriptId);
  assert.equal((await api.finish(known, setupEmail)).phase, 'authorizing');
});

test('other accounts, nonowners, and unrelated script IDs cannot resume a setup', async () => {
  const f = setupFixture(), api = service(f);
  const state = await api.create('Church', setupEmail);
  await assert.rejects(api.finish(state, 'another@example.test'), /account that started/);
  f.owned = false;
  await assert.rejects(api.finish(state, setupEmail), /Only the owner/);
  f.owned = true; f.parent = 'other_sheet_1234567890';
  await assert.rejects(api.finish(state, setupEmail), /does not belong/);
});

test('a public service mismatch cannot mark a group ready and can be retried', async () => {
  const f = setupFixture(), api = service(f);
  const state = await api.create('Church', setupEmail); f.authorize(); f.badService = true;
  await assert.rejects(api.finish(state, setupEmail), /connection check/);
  assert.equal((await api.load(setupSheetId)).phase, 'activating');
  f.badService = false;
  assert.equal((await api.finish(state, setupEmail)).phase, 'ready');
  assert.equal(f.deployments.length, 1);
});

test('setup requests cannot send bearer tokens to services, share files, or run arbitrary scripts', async () => {
  let calls = 0;
  for (const [url, method] of [['https://script.google.com/macros/s/1234567890123456/exec', 'POST'],
    ['https://www.googleapis.com/drive/v3/files/1234567890123456/permissions', 'POST'],
    ['https://script.googleapis.com/v1/scripts/1234567890123456:run', 'POST'],
    ['https://script.googleapis.com.evil.test/v1/projects', 'POST']]) {
    await assert.rejects(setupGoogle(url, method, session, { fetchImpl: () => { calls++; } }), /Unsupported/);
  }
  await assert.rejects(setupGoogle('https://script.googleapis.com/v1/projects', 'POST', { ...session, expiresAt: 0 }), /expired/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setupGoogle('https://script.googleapis.com/v1/projects', 'POST', session, { signal: controller.signal }), /abort/i);
  assert.equal(calls, 0);
  const f = setupFixture(); f.deny = true;
  await assert.rejects(service(f).create('Church', setupEmail), error => /Google denied/.test(error.message) && !error.message.includes('PRIVATE'));
});

test('script-management permission is requested separately and partial consent fails closed', async () => {
  const original = globalThis.window;
  const configs = [];
  globalThis.window = { google: { accounts: { oauth2: { initTokenClient(config) {
    configs.push(config);
    return { requestAccessToken() { config.callback({ access_token: 'token', expires_in: 3600, scope: SCOPES.join(' ') }); } };
  } } } } };
  try {
    await requestGoogleSession({ clientId: 'test' });
    assert.equal(SETUP_SCOPES.some(scope => configs[0].scope.includes(scope)), false);
    await assert.rejects(requestGoogleSession({ clientId: 'test' }, true), /script-management permission/);
    assert.ok(SETUP_SCOPES.every(scope => configs[1].scope.includes(scope)));
    assert.equal(configs[1].include_granted_scopes, false);
  } finally { globalThis.window = original; }
});

test('setup records reject malformed IDs, phases, and credentials', async () => {
  const f = setupFixture(); await service(f).create('Church', setupEmail);
  const original = JSON.parse(f.values[1][1]);
  for (const override of [{ phase: 'unknown' }, { scriptId: 'https://evil.test' }, { groupId: 'bad' }, { memberToken: original.submissionToken }]) {
    const values = structuredClone(f.values); values[1][1] = JSON.stringify({ ...original, ...override });
    assert.throws(() => parseSetup(values, setupSheetId), /Invalid/);
  }
});

test('selecting unfinished setup returns its wizard record instead of an incomplete dashboard', async () => {
  const f = setupFixture(); const state = await service(f).create('Church', setupEmail);
  const data = managedResponses(); data[1].sheets.push({ properties: { title: 'GroupSetup' } });
  const replies = [data[0], data[1], { valueRanges: [{ values: f.values }] }];
  const result = await readGroup(setupSheetId, session, { fetchImpl: async () => new Response(JSON.stringify(replies.shift())) });
  assert.equal(result.setup.installId, state.installId); assert.equal(result.setup.phase, 'authorizing');
  assert.equal(result.requests, undefined); assert.equal(replies.length, 0);
});

test('a ready setup record cannot silently replace console credentials or deployment links', async () => {
  const f = setupFixture(), api = service(f); const state = await api.create('Church', setupEmail);
  f.authorize(); await api.finish(state, setupEmail);
  const data = managedResponses(); data[1].sheets.push({ properties: { title: 'GroupSetup' } });
  const replies = [data[0], data[1], { valueRanges: [{ values: f.values }] }, data[2]];
  await assert.rejects(readGroup(setupSheetId, session, { fetchImpl: async () => new Response(JSON.stringify(replies.shift())) }), /do not match/);
});
