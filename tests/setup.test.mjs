import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const guide = await readFile(new URL('../public/setup.html', import.meta.url), 'utf8');
const keySection = guide.split('<h2 id="picker-key">')[1]?.split('<h2>5.')[0];

test('Picker setup allows both the console and the Google-hosted frame', () => {
  assert.ok(keySection, 'Picker setup anchor is missing');
  const websites = keySection.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1].split('\n');
  assert.deepEqual(websites, [
    'https://console.closetprayer.com/*', 'https://docs.google.com/*',
    'http://localhost:5174/*', 'http://localhost:4175/*',
  ]);
  assert.match(keySection, /not the OAuth client's Authorized JavaScript origins/);
});

test('Picker setup retains restrictions and includes both required APIs', () => {
  assert.match(keySection, /choose <strong>Restrict key<\/strong> and select both <strong>Google Picker API<\/strong> and <strong>Google Drive API<\/strong>/);
  assert.match(keySection, /does not require changing the GitHub variable or rebuilding/);
  assert.match(keySection, /do not make the spreadsheet public/);
  assert.match(guide, /href="#picker-key"/);
});

test('authorization instructions link directly to the Google Auth Platform', () => {
  assert.match(guide, /href="https:\/\/console.cloud.google.com\/auth\/branding"/);
});

test('Brave workaround keeps Shields enabled and explains the site-only cookie tradeoff', () => {
  const cookieSection = guide.split('<h3 id="brave-cookies">')[1]?.split('<footer>')[0];
  assert.ok(cookieSection, 'Brave cookie help anchor is missing');
  assert.match(cookieSection, /Keep <strong>Shields on<\/strong>/);
  assert.match(cookieSection, /change only the cookie setting/);
  assert.match(cookieSection, /Allow all cookies/);
  assert.match(cookieSection, /do not change global defaults/);
  assert.match(cookieSection, /permits third-party cookies/);
  assert.match(cookieSection, /restore your previous cookie setting/);
  assert.match(cookieSection, /cannot detect your cookie settings/);
  assert.match(cookieSection, /Do not make the sheet public or loosen API-key restrictions/);
});

test('connection, recovery, diagnostics, and privacy notice link to the same cookie help', async () => {
  for (const path of ['../src/main.jsx', '../src/PickerRecovery.jsx', '../public/privacy.html']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /href="\.\/setup\.html#brave-cookies"/);
  }
});
