import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSpreadsheet } from '../src/google.js';
import { appendConnectionStep, formatConnectionSteps } from '../src/connectionDiagnostics.js';
import { fileId } from './fixtures.mjs';

function fixture(t, behavior = {}) {
  const original = globalThis.window;
  const state = { callback: null, visibility: [], disposed: 0, steps: [] };
  class View { setMode() { return this; } setMimeTypes() { return this; } }
  class Builder {
    addView() { return this; } setTitle() { return this; } setOAuthToken() { return this; }
    setDeveloperKey() { return this; } setAppId() { return this; } setOrigin() { return this; }
    setCallback(callback) { state.callback = callback; return this; }
    build() {
      if (behavior.buildThrows) throw new Error('RAW SECRET ERROR');
      if (behavior.duringBuild) state.callback(behavior.duringBuild);
      return {
        setVisible(value) {
          state.visibility.push(value);
          if (!value && behavior.cancelOnHide) state.callback({ action: 'cancel' });
          if (!value && behavior.hideThrows) throw new Error('RAW SECRET ERROR');
        },
        dispose() {
          state.disposed++;
          if (behavior.disposeThrows) throw new Error('RAW SECRET ERROR');
        },
      };
    }
  }
  globalThis.window = { location: { origin: 'https://console.example' }, google: { picker: {
    DocsView: View, PickerBuilder: Builder, ViewId: { SPREADSHEETS: 'spreadsheets' },
    DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'picked', CANCEL: 'cancel', ERROR: 'error' },
    Response: { ACTION: 'action', DOCUMENTS: 'docs' }, Document: { ID: 'id' },
  } } };
  const controller = new AbortController();
  t.after(() => { controller.abort(); if (original === undefined) delete globalThis.window; else globalThis.window = original; });
  state.promise = pickSpreadsheet({ clientId: 'test', apiKey: 'test', projectNumber: '123' }, 'fake', controller.signal, code => {
    state.steps.push(code);
    if (behavior.observerThrows) throw new Error('Bad observer');
  });
  state.controller = controller;
  return state;
}
const picked = { action: 'picked', docs: [{ id: fileId, name: 'PRIVATE FILENAME', description: 'PRIVATE TEXT' }] };

test('confirmed selection hides the picker before disposal and resolves its ID', async t => {
  const state = fixture(t);
  state.callback({ action: 'loaded' });
  await Promise.resolve();
  assert.equal(state.steps.includes('picker-selection-received'), false);
  state.callback(picked);
  assert.equal(await state.promise, fileId);
  assert.deepEqual(state.visibility, [true, false]);
  assert.equal(state.disposed, 1);
  assert.equal(state.steps.includes('picker-selection-received'), true);
  assert.equal(JSON.stringify(state.steps).includes('PRIVATE'), false);
});

test('cleanup exceptions cannot swallow a confirmed selection', async t => {
  const state = fixture(t, { hideThrows: true, disposeThrows: true });
  assert.doesNotThrow(() => state.callback(picked));
  assert.equal(await state.promise, fileId);
  assert.equal(state.steps.includes('picker-cleanup-warning'), true);
  assert.equal(state.steps.includes('RAW SECRET ERROR'), false);
});

test('duplicate or reentrant cancellation cannot replace a confirmed selection', async t => {
  const state = fixture(t, { cancelOnHide: true });
  state.callback(picked);
  state.callback({ action: 'cancel' });
  assert.equal(await state.promise, fileId);
  assert.equal(state.disposed, 1);
  assert.equal(state.steps.includes('picker-cancelled'), false);
});

test('synchronous SDK callbacks wait until construction finishes', async t => {
  const state = fixture(t, { duringBuild: picked });
  assert.equal(await state.promise, fileId);
  assert.deepEqual(state.visibility, [true, false]);
  assert.equal(state.disposed, 1);
});

test('cancellation settles even if cleanup fails', async t => {
  const state = fixture(t, { disposeThrows: true });
  state.callback({ action: 'cancel' });
  assert.equal(await state.promise, null);
});

test('abort hides the picker and ignores a later selection', async t => {
  const state = fixture(t, { disposeThrows: true });
  const rejected = assert.rejects(state.promise, error => error.name === 'AbortError');
  state.controller.abort();
  state.callback(picked);
  await rejected;
  assert.deepEqual(state.visibility, [true, false]);
  assert.equal(state.steps.includes('picker-selection-received'), false);
});

test('invalid selection reports an error rather than hanging', async t => {
  const state = fixture(t);
  state.callback({ action: 'picked', docs: [] });
  await assert.rejects(state.promise, /valid spreadsheet/);
});

test('unexpected callback failures are sanitized and close the picker', async t => {
  const state = fixture(t);
  state.callback({ get action() { throw new Error('RAW SECRET ERROR'); } });
  await assert.rejects(state.promise, error => /process the picker response/.test(error.message) && !error.message.includes('SECRET'));
  assert.deepEqual(state.visibility, [true, false]);
});

test('Picker-reported errors are visible without returning raw SDK data', async t => {
  const state = fixture(t);
  state.callback({ action: 'error', error: 'RAW SECRET ERROR' });
  await assert.rejects(state.promise, error => /reported an error/.test(error.message) && !error.message.includes('SECRET'));
});

test('construction errors reject cleanly', async t => {
  const state = fixture(t, { buildThrows: true });
  await assert.rejects(state.promise, /could not open/);
});

test('a diagnostics observer cannot interrupt selection', async t => {
  const state = fixture(t, { observerThrows: true });
  state.callback(picked);
  assert.equal(await state.promise, fileId);
});

test('diagnostics accept only fixed step codes and remain bounded', () => {
  let events = [];
  for (let n = 0; n < 40; n++) events = appendConnectionStep(events, 'picker-loaded', n);
  assert.equal(events.length, 24);
  assert.equal(appendConnectionStep(events, 'PRIVATE DATA'), events);
  const report = formatConnectionSteps([...events, { code: 'SECRET TOKEN', at: 0 }, { code: 'picker-open', at: 0, name: 'PRIVATE NAME' }]);
  assert.doesNotMatch(report, /SECRET|PRIVATE/);
  assert.match(report, /picker-open/);
});
