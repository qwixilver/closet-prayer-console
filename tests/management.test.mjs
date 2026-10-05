import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { callConsoleService, parseConsoleSettings, parseCommands, submissionLinks } from '../src/consoleProtocol.js';
import { googleJson, readGroup, parseRows } from '../src/groupReader.js';
import { processPending, rowRevision, saveCommand, verifyManagement } from '../src/groupWriter.js';
import { fileId, groupId, endpoint, settingsRows, managedResponses, requestHeaders, requestRow, inboxHeaders, inboxRow } from './fixtures.mjs';

const session = () => ({ token: 'PRIVATE_GOOGLE_TOKEN', expiresAt: Date.now() + 60000 });
function fixture() {
  const data = managedResponses();
  const state = { calls: [], outcome: 'applied', deny: false, mismatch: false, loseAppend: false, loseProcess: false };
  const options = { fetchImpl: async (url, init) => {
    state.calls.push({ url, init });
    let body;
    if (url === endpoint) {
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
      assert.doesNotMatch(init.body, /PRIVATE_GOOGLE_TOKEN/);
      const input = JSON.parse(init.body);
      assert.deepEqual(Object.keys(input).sort(), [...['protocol', 'version', 'groupId', 'token', 'action'], ...(input.requestId ? ['requestId'] : [])].sort());
      body = { protocol: 'cp-group', version: 1, ok: true, group: { id: groupId }, consoleVersion: 1, sheetId: state.mismatch ? 'different_sheet_id' : fileId };
      if (input.action === 'console-process') {
        const rows = data[2].valueRanges[3].values;
        const row = rows.find(row => row[0] === input.requestId);
        body.outcome = row ? row[3] === 'pending' ? state.outcome : row[3] : 'not-found';
        if (row) row[3] = body.outcome;
        if (state.loseProcess) { state.loseProcess = false; throw new TypeError('Lost response'); }
      }
    } else {
      assert.equal(init.headers.Authorization, 'Bearer PRIVATE_GOOGLE_TOKEN');
      assert.equal(init.redirect, 'error');
      if (state.deny) return new Response('{}', { status: 403 });
      if (url.includes(':append')) {
        const input = JSON.parse(init.body);
        assert.equal(new URL(url).searchParams.get('valueInputOption'), 'RAW');
        assert.equal(init.method, 'POST');
        data[2].valueRanges[3].values.push(...input.values);
        if (state.loseAppend) { state.loseAppend = false; throw new TypeError('Lost append result'); }
        body = {};
      } else if (url.includes('values:batchGet')) body = data[2];
      else if (url.includes('sheets.googleapis.com')) body = data[1];
      else body = data[0];
    }
    return new Response(JSON.stringify(body), { status: 200 });
  } };
  return { data, state, options };
}
const operation = () => ({ id: randomUUID(), createdAt: new Date().toISOString(), command: { version: 1, type: 'create', id: randomUUID(),
  prayer: { title: 'Literal =text', description: 'Test only', requestor: '', publication: 'draft', visibility: 'group-only', consent: 'group-only', status: 'requested', requestedAt: '2026-10-01T00:00:00Z' } } });

test('row revisions match the script canonical JSON, including date normalization', async () => {
  for (const [headers, cells, type] of [[requestHeaders, requestRow, 'Requests'], [inboxHeaders, inboxRow, 'Inbox']]) {
    const row = parseRows([headers, cells], type)[0];
    const canonical = cells.map((cell, i) => ['receivedAt', 'requestedAt'].includes(headers[i]) ? new Date(cell).toISOString() : cell);
    assert.equal(await rowRevision(row, type === 'Inbox'), createHash('sha256').update(JSON.stringify(canonical)).digest('base64url'));
  }
  const cells = [...requestRow];
  const canonicalDate = '2026-10-01T00:00:00.123Z';
  cells[7] = Date.parse(canonicalDate) / 86400000 + 25569;
  const row = parseRows([requestHeaders, cells], 'Requests')[0];
  assert.equal(row.date, canonicalDate);
  cells[7] = canonicalDate;
  assert.equal(await rowRevision(row), createHash('sha256').update(JSON.stringify(cells)).digest('base64url'));
});

test('only submission-scoped links enter iframe HTML, and settings reject unsafe endpoints', () => {
  const settings = parseConsoleSettings(settingsRows);
  const links = submissionLinks(settings);
  assert.match(links.link, /#group=CPG1\.s\./); assert.doesNotMatch(links.embed, /CPG1\.m\.|PRIVATE_GOOGLE/);
  assert.match(links.embed, /referrerpolicy="no-referrer"/);
  for (const bad of ['https://evil.example/exec', endpoint + '?redirect=evil', endpoint.replace('/exec', '/dev'), 'http://script.google.com/macros/s/test_deployment_1234567890/exec']) {
    const values = structuredClone(settingsRows); values[4][1] = bad;
    assert.throws(() => parseConsoleSettings(values));
  }
});

test('Google writes go only to the private command queue; public processing never receives the Google token or command payload', async () => {
  const { options, state } = fixture();
  const group = await readGroup(fileId, session(), options);
  const result = await saveCommand(group, operation(), session(), options);
  assert.equal(result.commands[0].outcome, 'applied');
  assert.equal(state.calls.filter(call => call.url.includes(':append')).length, 1);
});

test('uncertain append and processing results retry the same operation without a second append', async () => {
  for (const phase of ['loseAppend', 'loseProcess']) {
    const { options, state } = fixture();
    const group = await readGroup(fileId, session(), options), change = operation();
    state[phase] = true;
    await assert.rejects(saveCommand(group, change, session(), options), TypeError);
    const result = await saveCommand(group, change, session(), options);
    assert.equal(result.commands[0].outcome, 'applied');
    assert.equal(state.calls.filter(call => call.url.includes(':append')).length, 1);
  }
});

test('revoked access and a mismatched service block writes', async () => {
  for (const failure of ['deny', 'mismatch']) {
    const { options, state } = fixture();
    const group = await readGroup(fileId, session(), options);
    state[failure] = true;
    await assert.rejects(saveCommand(group, operation(), session(), options));
    assert.equal(state.calls.some(call => call.url.includes(':append')), false);
  }
});

test('conflict is visible, pending completion does not create a command, and expired sessions do not write', async () => {
  const { options, state, data } = fixture();
  const group = await readGroup(fileId, session(), options), change = operation();
  state.outcome = 'conflict';
  await assert.rejects(saveCommand(group, change, session(), options), /changed since/);
  await assert.rejects(processPending(group, change.id, session(), options), /changed since/);
  assert.equal(data[2].valueRanges[3].values.length, 2);
  const count = state.calls.length;
  await assert.rejects(saveCommand(group, operation(), { token: 'expired', expiresAt: 1 }, options), /expired/);
  assert.equal(state.calls.length, count);
});

test('unsupported authenticated endpoints and public actions are rejected before fetching', async () => {
  const never = { fetchImpl() { throw new Error('Must not fetch'); } };
  await assert.rejects(googleJson('https://attacker.invalid/', session(), never), /Unsupported/);
  await assert.rejects(googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}`, session(), never, {}), /Unsupported/);
  await assert.rejects(callConsoleService(parseConsoleSettings(settingsRows), 'approve', never), /Unsupported/);
  await assert.rejects(verifyManagement({ id: fileId, management: null }, never), /Upgrade/);
});

test('invalid and conflicting queue records are not offered for retry', () => {
  const header = ['id', 'createdAt', 'command', 'outcome', 'completedAt'];
  const change = operation(), row = [change.id, change.createdAt, JSON.stringify(change.command), 'pending', ''];
  assert.equal(parseCommands([header, row]).length, 1);
  assert.throws(() => parseCommands([header, [...row.slice(0, 3), 'unknown']]), /Invalid/);
  const other = [...row]; other[2] = JSON.stringify(operation().command);
  assert.throws(() => parseCommands([header, row, other]), /Conflicting/);
});
