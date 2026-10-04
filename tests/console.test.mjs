import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DRIVE_SCOPE, SCOPES, parseToken, readConfig } from '../src/google.js';
import { INBOX_HEADERS, REQUEST_HEADERS, parseRows, readGroup, readProfile } from '../src/groupReader.js';
import { fileId, inboxHeaders, inboxRow, requestHeaders, requestRow, responses } from './fixtures.mjs';

const session = () => ({ token: 'fake-test-token', expiresAt: Date.now() + 60000 });
function mockFetch(data) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const next = data.shift();
    assert.notEqual(next, undefined, 'Unexpected request');
    return new Response(JSON.stringify(next.body ?? next), { status: next.status ?? 200 });
  } };
}

test('public configuration is required, without a client secret', () => {
  assert.equal(readConfig({}).ready, false);
  assert.equal(readConfig({ VITE_GOOGLE_CLIENT_ID: 'wrong', VITE_GOOGLE_API_KEY: 'x'.repeat(30), VITE_GOOGLE_PROJECT_NUMBER: '1234' }).ready, false);
  assert.equal(readConfig({ VITE_GOOGLE_CLIENT_ID: '1234-example.apps.googleusercontent.com', VITE_GOOGLE_API_KEY: 'x'.repeat(30), VITE_GOOGLE_PROJECT_NUMBER: '1234' }).ready, true);
  assert.equal(SCOPES.includes('https://www.googleapis.com/auth/drive'), false);
  assert.equal(SCOPES.includes('https://www.googleapis.com/auth/spreadsheets'), false);
});

test('tokens require a granted per-file scope and a bounded lifetime', () => {
  const response = { access_token: 'fake', scope: DRIVE_SCOPE, expires_in: 3600 };
  assert.deepEqual(parseToken(response, 1000), { token: 'fake', expiresAt: 3571000 });
  for (const expires_in of [0, -1, NaN, 'bad', 10000000000]) assert.throws(() => parseToken({ ...response, expires_in }), /invalid session/);
  assert.throws(() => parseToken({ ...response, scope: 'openid' }), /not granted/);
  assert.throws(() => parseToken({ error: 'access_denied' }), /not approved/);
});

test('schema matches the existing church-owned template', () => {
  assert.deepEqual(REQUEST_HEADERS, requestHeaders);
  assert.deepEqual(INBOX_HEADERS, inboxHeaders);
});

test('sharing uses the most restrictive consent', () => {
  for (const [visibility, consent] of [['shareable', 'group-only'], ['group-only', 'shareable'], ['group-only', 'group-only']]) {
    const row = [...requestRow]; row[2] = visibility; row[3] = consent;
    assert.equal(parseRows([requestHeaders, row], 'Requests')[0].sharing, 'group-only');
  }
  const row = [...requestRow]; row[3] = 'shareable';
  assert.equal(parseRows([requestHeaders, row], 'Requests')[0].sharing, 'shareable');
  assert.equal(parseRows([inboxHeaders, inboxRow], 'Inbox')[0].sharing, 'group-only');
});

test('empty rows are skipped and Sheets serial dates are supported', () => {
  const row = [...requestRow]; row[7] = 25569;
  const parsed = parseRows([requestHeaders, [], ['', ''], row], 'Requests');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].date, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(parseRows([inboxHeaders], 'Inbox'), []);
});

test('malformed headers, IDs, text, dates, and states fail closed without content in errors', () => {
  assert.throws(() => parseRows([['wrong']], 'Requests'), /headers/);
  assert.throws(() => parseRows([requestHeaders, requestRow, requestRow], 'Requests'), /duplicate/);
  for (const [column, value] of [[0, 'BAD-ID'], [1, 'unknown'], [3, 'unknown'], [4, ''], [5, 'x'.repeat(10001)], [7, 'bad date'], [8, 'unknown']]) {
    const row = [...requestRow]; row[column] = value;
    assert.throws(() => parseRows([requestHeaders, row], 'Requests'), error => !error.message.includes(requestRow[5]));
  }
  assert.throws(() => parseRows([requestHeaders, ...Array(2001).fill([])], 'Requests'), /archive/);
});

test('reader checks Editor capability before reading prayer content', async () => {
  const data = responses(); data[0].capabilities.canEdit = false;
  const mock = mockFetch(data);
  await assert.rejects(readGroup(fileId, session(), mock), /Editor permission/);
  assert.equal(mock.calls.length, 1);
});

test('only Google fixed endpoints and read-only, no-store requests receive tokens', async () => {
  const mock = mockFetch(responses());
  const group = await readGroup(fileId, session(), mock);
  assert.equal(group.requests.length, 1);
  assert.equal(group.inbox[0].contact, inboxRow[5]);
  assert.equal(group.requests[0].contact, undefined);
  for (const { url, options } of mock.calls) {
    assert.ok(['www.googleapis.com', 'sheets.googleapis.com'].includes(new URL(url).hostname));
    assert.equal(url.includes('fake-test-token'), false);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
  }
  const valuesUrl = new URL(mock.calls[2].url);
  assert.deepEqual(valuesUrl.searchParams.getAll('ranges'), ["'Requests'!A1:I1000", "'Inbox'!A1:H1000"]);
  assert.equal(valuesUrl.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
});

test('unsafe file identifiers cannot redirect authenticated requests', async () => {
  const mock = mockFetch([]);
  for (const id of ['https://evil.example/x', '../etc', 'abc?key=value', '', null]) {
    await assert.rejects(readGroup(id, session(), mock), /valid spreadsheet/);
  }
  assert.equal(mock.calls.length, 0);
});

test('requests detect truncation and do not scan unrelated tabs', async () => {
  const data = responses(); data[1].sheets[0].properties.gridProperties.rowCount = 5000;
  const mock = mockFetch(data);
  await readGroup(fileId, session(), mock);
  assert.equal(new URL(mock.calls[2].url).searchParams.getAll('ranges')[0], "'Requests'!A1:I5000");
  const beyondGap = responses();
  beyondGap[1].sheets[0].properties.gridProperties.rowCount = 5000;
  beyondGap[2].valueRanges[0].values = [requestHeaders, ...Array(3000).fill([]), requestRow];
  await assert.rejects(readGroup(fileId, session(), mockFetch(beyondGap)), /archive/);
  const missing = responses(); missing[1].sheets = [];
  const other = mockFetch(missing);
  await assert.rejects(readGroup(fileId, session(), other), /not a configured/);
  assert.equal(other.calls.length, 2);
});

test('expired tokens never trigger a request', async () => {
  const mock = mockFetch([]);
  await assert.rejects(readGroup(fileId, { token: 'expired', expiresAt: 1 }, mock), error => error.status === 401);
  assert.equal(mock.calls.length, 0);
});

test('API denial is sanitized and cancellable', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const mock = mockFetch([{ status, body: { error: { message: 'SECRET DATA' } } }]);
    await assert.rejects(readGroup(fileId, session(), mock), error => error.status === status && !error.message.includes('SECRET DATA'));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readGroup(fileId, session(), { signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    signal.throwIfAborted();
  } }), error => error.name === 'AbortError');
});

test('profile is fetched from Google rather than decoded from an unverified token', async () => {
  const mock = mockFetch([{ sub: '123', name: 'Example', email: 'test@example.invalid', email_verified: true }]);
  assert.equal((await readProfile(session(), mock)).email, 'test@example.invalid');
  assert.equal(mock.calls[0].url, 'https://openidconnect.googleapis.com/v1/userinfo');
  await assert.rejects(readProfile(session(), mockFetch([{ sub: '123', email: 'test@example.invalid', email_verified: false }])), /verified/);
});

test('no persistence, untrusted HTML injection, or provider write methods are introduced', async () => {
  for (const path of ['../src/main.jsx', '../src/google.js', '../src/groupReader.js', '../src/connectionDiagnostics.js', '../src/pickerFrameDiagnostics.js', '../src/PickerRecovery.jsx']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|console\.log/);
    assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|DELETE|PATCH)['"]/);
  }
});
