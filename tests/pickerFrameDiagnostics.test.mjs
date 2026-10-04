import test from 'node:test';
import assert from 'node:assert/strict';
import { observePickerFrame } from '../src/pickerFrameDiagnostics.js';

function fixture(t) {
  const previous = { document: globalThis.document, window: globalThis.window, MutationObserver: globalThis.MutationObserver };
  const frame = new EventTarget();
  frame.src = 'https://docs.google.com/picker?oauth_token=PRIVATE_TOKEN';
  frame.contentWindow = {};
  const window = new EventTarget();
  globalThis.document = { querySelectorAll: () => [frame] };
  globalThis.window = window;
  const observer = { callback: null, disconnected: false };
  globalThis.MutationObserver = class {
    constructor(callback) { observer.callback = callback; }
    observe() { observer.disconnected = false; }
    disconnect() { observer.disconnected = true; }
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const steps = [];
  return { frame, window, steps, observer, start: () => observePickerFrame(code => steps.push(code)),
    message(origin = 'https://docs.google.com', source = frame.contentWindow) {
      const event = new Event('message');
      Object.defineProperties(event, { origin: { value: origin }, source: { value: source },
        data: { get() { throw new Error('Message contents must never be read'); } } });
      window.dispatchEvent(event);
    },
  };
}

test('frame diagnostics require the exact Google origin and picker source, without reading payloads', t => {
  const state = fixture(t);
  const stop = state.start();
  state.message('https://docs.google.com.attacker.invalid');
  state.message('https://docs.google.com', {});
  state.message('null');
  assert.deepEqual(state.steps, []);
  state.message(); state.message();
  assert.deepEqual(state.steps, ['picker-frame-message']);
  stop();
});

test('frame load/reload diagnostics are bounded and every observer is removed on cleanup', t => {
  const state = fixture(t);
  const stop = state.start();
  for (let i = 0; i < 10; i++) state.frame.dispatchEvent(new Event('load'));
  assert.deepEqual(state.steps, ['picker-frame-loaded', 'picker-frame-reloaded']);
  stop();
  state.message(); state.frame.dispatchEvent(new Event('load'));
  assert.equal(state.steps.length, 2);
});

test('unrelated or ambiguous frames are not monitored', t => {
  const state = fixture(t);
  for (const src of ['about:blank', 'https://docs.google.com/not-picker', 'https://other.invalid/picker']) {
    state.frame.src = src;
    state.start()();
    state.message();
  }
  state.frame.src = 'https://docs.google.com/picker';
  document.querySelectorAll = () => [state.frame, state.frame];
  state.start()(); state.message();
  assert.deepEqual(state.steps, []);
});

test('the real SDK may create its iframe asynchronously after opening', t => {
  const state = fixture(t);
  document.querySelectorAll = () => [];
  const stop = state.start();
  state.message();
  assert.deepEqual(state.steps, []);
  document.querySelectorAll = () => [state.frame];
  state.observer.callback();
  assert.equal(state.observer.disconnected, true);
  state.frame.dispatchEvent(new Event('load'));
  state.message();
  assert.deepEqual(state.steps, ['picker-frame-loaded', 'picker-frame-message']);
  stop();
});
