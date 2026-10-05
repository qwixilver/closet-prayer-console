// SPDX-License-Identifier: GPL-3.0-only
import { GoogleAccessError } from './groupReader.js';
import { UUID, callConsoleService } from './consoleProtocol.js';

const ID = /^[\w-]{16,160}$/;
const TOKEN = /^[\w-]{43}$/;
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCRIPTS = 'https://script.googleapis.com/v1/projects';
const phases = ['creating-script', 'project-ready', 'authorizing', 'activating', 'ready'];
const recovery = 'Choose this same spreadsheet to resume. Do not create another group to retry.';

export function parseSetup(values, sheetId) {
  if (!Array.isArray(values) || JSON.stringify(values[0]) !== '["key","value"]' || values[1]?.[0] !== 'setup') throw new Error('Invalid group setup record.');
  let state;
  try { state = JSON.parse(values[1][1]); } catch { throw new Error('Invalid group setup record.'); }
  if (state?.protocol !== 'cp-setup' || state.version !== 1 || !UUID.test(state.installId || '') ||
      !UUID.test(state.groupId || '') || !TOKEN.test(state.memberToken || '') || !TOKEN.test(state.submissionToken || '') ||
      state.memberToken === state.submissionToken || typeof state.name !== 'string' || !state.name.trim() || state.name.length > 120 ||
      typeof state.owner !== 'string' || !state.owner.includes('@') || !phases.includes(state.phase) ||
      !ID.test(sheetId || '') || (state.scriptId && !ID.test(state.scriptId)) || (state.deploymentId && !ID.test(state.deploymentId)) ||
      (state.phase !== 'creating-script' && !state.scriptId) || (['authorizing', 'activating', 'ready'].includes(state.phase) && !state.deploymentId)) throw new Error('Invalid group setup record.');
  return { ...state, sheetId, authorized: values[2]?.[0] === 'authorized' ? values[2][1] : '' };
}

export function setupEndpoint(state) {
  if (!ID.test(state.deploymentId || '')) throw new Error('The group has no deployment yet.');
  return `https://script.google.com/macros/s/${state.deploymentId}/exec`;
}

export function memberLink(state) {
  if (!UUID.test(state.groupId || '') || !TOKEN.test(state.memberToken || '')) throw new Error('Invalid member invitation.');
  setupEndpoint(state);
  return `https://closetprayer.com/#group=CPG1.m.${state.deploymentId}.${state.groupId}.${state.memberToken}`;
}

// Fixed Google endpoints only. This adapter deliberately cannot share files or
// send an administrator bearer token to a church web-app URL.
export async function setupGoogle(url, method, session, options = {}, body) {
  const target = new URL(url);
  const allowed = target.origin === 'https://sheets.googleapis.com'
    ? (method === 'POST' && (target.pathname === '/v4/spreadsheets' || /^\/v4\/spreadsheets\/[\w-]{16,160}\/values:batchUpdate$/.test(target.pathname))) ||
      (method === 'GET' && /^\/v4\/spreadsheets\/[\w-]{16,160}\/values\/GroupSetup!A1:B3$/.test(target.pathname))
    : target.origin === 'https://script.googleapis.com'
      ? (method === 'POST' && /^\/v1\/projects(?:\/[\w-]{16,160}\/(versions|deployments))?$/.test(target.pathname)) ||
        (method === 'PUT' && /^\/v1\/projects\/[\w-]{16,160}\/(content|deployments\/[\w-]{16,160})$/.test(target.pathname)) ||
        (method === 'GET' && /^\/v1\/projects\/[\w-]{16,160}(?:\/deployments)?$/.test(target.pathname))
      : target.origin === 'https://www.googleapis.com' && method === 'GET' && /^\/drive\/v3\/files\/[\w-]{16,160}$/.test(target.pathname);
  if (!allowed || target.username || target.password || target.hash) throw new Error('Unsupported setup request.');
  options.signal?.throwIfAborted();
  if (Date.now() >= session.expiresAt) throw new GoogleAccessError('Your Google session expired. Reconnect and resume setup.', 401);
  const response = await (options.fetchImpl || fetch)(url, { method, credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) throw new GoogleAccessError(response.status === 403
    ? 'Google denied setup access. Check that Apps Script API access is on in your Google settings, the console operator enabled the API, and your organization permits public web apps.'
    : response.status === 401 ? 'Your Google session expired. Reconnect and resume setup.'
      : 'Google could not complete setup. ' + recovery, response.status);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Unexpected setup response.');
  try { return JSON.parse(text); } catch { throw new Error('Google returned an unreadable setup response. ' + recovery); }
}

function encodedState(state) {
  const { sheetId, authorized, ...saved } = state;
  return JSON.stringify(saved);
}
function literalRows(values) {
  return values.map(row => ({ values: row.map(value => ({ userEnteredValue: { stringValue: value } })) }));
}
function newToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createSetupService(source, session, options = {}) {
  const api = (url, method = 'GET', body) => setupGoogle(url, method, session, options, body);
  const checkpoint = state => options.onCheckpoint?.({ ...state });
  async function save(state) {
    checkpoint(state); // Preserve known IDs in this tab even if the following write fails.
    await api(`${SHEETS}/${state.sheetId}/values:batchUpdate`, 'POST', { valueInputOption: 'RAW',
      data: [{ range: 'GroupSetup!A1:B2', values: [['key', 'value'], ['setup', encodedState(state)]] }] });
  }
  async function load(sheetId) {
    if (!ID.test(sheetId)) throw new Error('Invalid spreadsheet.');
    const record = await api(`${SHEETS}/${sheetId}/values/GroupSetup!A1:B3`);
    return parseSetup(record.values, sheetId);
  }
  async function verifyOwner(state, email) {
    if (state.owner.toLowerCase() !== email.toLowerCase()) throw new Error('Resume with the Google account that started this group.');
    const file = await api(`https://www.googleapis.com/drive/v3/files/${state.sheetId}?fields=ownedByMe,trashed`);
    if (file.ownedByMe !== true || file.trashed) throw new Error('Only the owner of this newly created spreadsheet can finish setup.');
    if (state.scriptId) {
      const project = await api(`${SCRIPTS}/${state.scriptId}`);
      if (project.parentId !== state.sheetId || project.scriptId !== state.scriptId) throw new Error('The script does not belong to this setup spreadsheet. Nothing was changed.');
    }
  }
  async function content(state, publicService) {
    const manifest = { timeZone: 'Etc/UTC', runtimeVersion: 'V8',
      dependencies: { enabledAdvancedServices: [{ userSymbol: 'Sheets', serviceId: 'sheets', version: 'v4' }] },
      oauthScopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.container.ui'],
      webapp: { access: publicService ? 'ANYONE_ANONYMOUS' : 'MYSELF', executeAs: publicService ? 'USER_DEPLOYING' : 'USER_ACCESSING' } };
    const files = [{ name: 'Code', type: 'SERVER_JS', source }, { name: 'appsscript', type: 'JSON', source: JSON.stringify(manifest) }];
    // The public version has no bootstrap constant, so anonymous GETs cannot initialize it.
    if (!publicService) files.push({ name: 'Install', type: 'SERVER_JS', source: `const CP_INSTALL = ${JSON.stringify({ sheetId: state.sheetId,
      installId: state.installId, groupId: state.groupId, name: state.name, memberToken: state.memberToken, submissionToken: state.submissionToken })};` });
    await api(`${SCRIPTS}/${state.scriptId}/content`, 'PUT', { files });
    const version = await api(`${SCRIPTS}/${state.scriptId}/versions`, 'POST', { description: `Closet Prayer ${publicService ? 'service' : 'approval'} ${state.installId}` });
    if (!Number.isInteger(version.versionNumber) || version.versionNumber < 1) throw new Error('Google did not return a script version.');
    return { versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: `Closet Prayer ${state.installId}` };
  }
  async function prepare(state, email) {
    await verifyOwner(state, email);
    if (state.phase === 'creating-script' && !state.scriptId) throw new Error('Script creation was interrupted before its ID was confirmed. Open this sheet and Extensions > Apps Script to check whether it was created. Do not retry by creating another group; see setup recovery in the guide.');
    if (state.phase !== 'project-ready') return state;
    // Reconcile a possibly completed deployment after a lost response.
    const existing = await api(`${SCRIPTS}/${state.scriptId}/deployments?pageSize=50`);
    if (existing.nextPageToken) throw new Error('This setup has unexpected deployment history. Contact support before continuing.');
    const matching = (existing.deployments || []).filter(item => item.deploymentConfig?.description === `Closet Prayer ${state.installId}`);
    if (matching.length > 1) throw new Error('More than one setup deployment exists. Resolve it before continuing.');
    if (matching[0]) state = { ...state, deploymentId: matching[0].deploymentId };
    else {
      const deployment = await api(`${SCRIPTS}/${state.scriptId}/deployments`, 'POST', await content(state, false));
      state = { ...state, deploymentId: deployment.deploymentId };
    }
    setupEndpoint(state);
    state = { ...state, phase: 'authorizing' };
    await save(state);
    return state;
  }
  async function create(name, email) {
    name = name.trim();
    if (!name || name.length > 120 || !email?.includes('@')) throw new Error('Enter a group name and connect Google first.');
    let state = { protocol: 'cp-setup', version: 1, installId: crypto.randomUUID(), groupId: crypto.randomUUID(),
      name, owner: email, memberToken: newToken(), submissionToken: newToken(), phase: 'creating-script' };
    const tabs = { Requests: [['id', 'publication', 'visibility', 'consent', 'title', 'description', 'requestor', 'requestedAt', 'status']],
      Inbox: [['id', 'receivedAt', 'title', 'description', 'requestor', 'contact', 'allowedSharing', 'reviewStatus']],
      ConsoleSettings: [['key', 'value']], ConsoleCommands: [['id', 'createdAt', 'command', 'outcome', 'completedAt']],
      GroupSetup: [['key', 'value'], ['setup', encodedState(state)], ['authorized', '']] };
    // Initial recovery state and literal headers are part of the same create request.
    const sheet = await api(SHEETS, 'POST', { properties: { title: `${name} - Closet Prayer`, timeZone: 'Etc/UTC' },
      sheets: Object.entries(tabs).map(([title, values], index) => ({ properties: { sheetId: index, title,
        gridProperties: { rowCount: 2002, columnCount: 10, frozenRowCount: 1 } }, data: [{ rowData: literalRows(values) }] })) });
    if (!ID.test(sheet.spreadsheetId || '')) throw new Error('The new spreadsheet could not be confirmed. Check Google Drive before trying again.');
    state = { ...state, sheetId: sheet.spreadsheetId }; checkpoint(state);
    const project = await api(SCRIPTS, 'POST', { title: `${name} - Closet Prayer service`, parentId: state.sheetId });
    if (!ID.test(project.scriptId || '')) throw new Error('Google did not confirm the new script. ' + recovery);
    state = { ...state, scriptId: project.scriptId, phase: 'project-ready' };
    await save(state);
    return prepare(state, email);
  }
  async function finish(known, email) {
    // A known script ID can repair a failed checkpoint write without recreating resources.
    let state = await load(known.sheetId);
    if (state.installId !== known.installId) throw new Error('The setup record changed. Select the sheet again.');
    if (state.phase === 'creating-script' && known.scriptId) {
      await verifyOwner(known, email); state = { ...state, scriptId: known.scriptId, phase: 'project-ready' }; await save(state);
    }
    await verifyOwner(state, email);
    state = await prepare(state, email); checkpoint(state);
    if (state.phase === 'authorizing') {
      if (state.authorized !== state.installId) return state;
      state = { ...state, phase: 'activating' }; await save(state);
    }
    if (state.phase === 'activating') {
      if (state.authorized !== state.installId) throw new Error('Google approval has not been confirmed.');
      const deploymentConfig = await content(state, true);
      await api(`${SCRIPTS}/${state.scriptId}/deployments/${state.deploymentId}`, 'PUT', { deploymentConfig });
      const settings = [['key', 'value'], ['protocol', 'cp-console'], ['version', '1'], ['groupId', state.groupId],
        ['endpoint', setupEndpoint(state)], ['submissionToken', state.submissionToken]];
      await api(`${SHEETS}/${state.sheetId}/values:batchUpdate`, 'POST', { valueInputOption: 'RAW', data: [{ range: 'ConsoleSettings!A1:B6', values: settings }] });
    }
    if (!['activating', 'ready'].includes(state.phase)) return state;
    const management = { groupId: state.groupId, token: state.submissionToken, endpoint: setupEndpoint(state) };
    const verified = await callConsoleService(management, 'console-info', options);
    if (verified.sheetId !== state.sheetId || verified.consoleVersion !== 1 || verified.capabilities?.memberSubmissions !== true) throw new Error('The deployed group has not passed its connection check. Wait a moment, then choose Finish setup again.');
    // Also verify the private invitation, without writing a test prayer to the inbox.
    const response = await (options.fetchImpl || fetch)(management.endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ protocol: 'cp-group', version: 1, groupId: state.groupId, token: state.memberToken, action: 'sync' }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
    const text = await response.text();
    if (!response.ok || text.length > 2_000_000) throw new Error('The member invitation could not be verified.');
    let result; try { result = JSON.parse(text); } catch { throw new Error('Google approval or public deployment is incomplete.'); }
    if (result.protocol !== 'cp-group' || result.version !== 1 || result.ok !== true || result.group?.id !== state.groupId ||
        result.complete !== true || !Array.isArray(result.prayers)) throw new Error('The member invitation could not be verified.');
    state = { ...state, phase: 'ready' }; await save(state);
    return state;
  }
  return { create, finish, load };
}
