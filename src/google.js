// SPDX-License-Identifier: GPL-3.0-only
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile', DRIVE_SCOPE];

export function readConfig(env) {
  const clientId = (env.VITE_GOOGLE_CLIENT_ID || '').trim();
  const apiKey = (env.VITE_GOOGLE_API_KEY || '').trim();
  const projectNumber = (env.VITE_GOOGLE_PROJECT_NUMBER || '').trim();
  return { clientId, apiKey, projectNumber,
    ready: /^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId) &&
      apiKey.length >= 20 && /^\d+$/.test(projectNumber) };
}

let sdkPromise;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => finish(new Error('Google took too long to load. Reload to try again.')), 15000);
    function finish(error) {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    }
    script.src = src;
    script.async = true;
    script.onload = () => finish();
    script.onerror = () => finish(new Error('Google could not load. Check your connection or browser blocking settings.'));
    document.head.append(script);
  });
}

export function loadGoogle() {
  if (!sdkPromise) sdkPromise = (async () => {
    await loadScript('https://accounts.google.com/gsi/client');
    await loadScript('https://apis.google.com/js/api.js');
    await new Promise((resolve, reject) => window.gapi.load('picker', {
      callback: resolve,
      onerror: () => reject(new Error('Google Picker could not load. Reload to try again.')),
      timeout: 15000,
      ontimeout: () => reject(new Error('Google Picker timed out. Reload to try again.')),
    }));
  })();
  return sdkPromise;
}

export function parseToken(response, now = Date.now()) {
  if (response?.error || typeof response?.access_token !== 'string' || !response.access_token) {
    throw new Error('Google connection was not approved. You can try again.');
  }
  const granted = new Set((response.scope || '').split(/\s+/));
  if (!granted.has(DRIVE_SCOPE)) throw new Error('File access was not granted. Allow access to files you select to continue.');
  const seconds = Number(response.expires_in);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86400) {
    throw new Error('Google returned an invalid session. Please connect again.');
  }
  return { token: response.access_token, expiresAt: now + seconds * 1000 - 30000 };
}

// Called synchronously from a button click so Google's popup retains the user gesture.
export function requestGoogleSession(config) {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: SCOPES.join(' '),
      include_granted_scopes: false,
      callback: response => {
        try { resolve(parseToken(response)); } catch (error) { reject(error); }
      },
      error_callback: () => reject(new Error('The Google window was closed or blocked. Allow popups and try again.')),
    });
    client.requestAccessToken({ prompt: 'select_account' });
  });
}

export function pickSpreadsheet(config, token, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const google = window.google;
    let picker;
    function finish(id, error) {
      signal.removeEventListener('abort', abort);
      picker?.dispose();
      if (error) reject(error); else resolve(id);
    }
    function abort() { finish(null, new DOMException('Cancelled', 'AbortError')); }
    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
      .setMode(google.picker.DocsViewMode.LIST)
      .setMimeTypes('application/vnd.google-apps.spreadsheet');
    picker = new google.picker.PickerBuilder()
      .addView(view)
      .setTitle('Choose a church-owned prayer group spreadsheet')
      .setOAuthToken(token)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.projectNumber)
      .setOrigin(window.location.origin)
      .setCallback(data => {
        if (data.action === google.picker.Action.PICKED) {
          const id = data.docs?.[0]?.id;
          if (!/^[\w-]{16,200}$/.test(id || '')) finish(null, new Error('Google did not return a valid spreadsheet.'));
          else finish(id);
        } else if (data.action === google.picker.Action.CANCEL) finish(null);
        else if (data.action === google.picker.Action.ERROR) finish(null, new Error('Google Picker could not open this file. Check the API key and project setup.'));
      })
      .build();
    signal.addEventListener('abort', abort, { once: true });
    picker.setVisible(true);
  });
}
