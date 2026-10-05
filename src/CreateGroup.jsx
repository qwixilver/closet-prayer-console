// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import { requestGoogleSession } from './google.js';
import { readProfile } from './groupReader.js';
import { createSetupService, setupEndpoint } from './groupSetup.js';
import serviceSource from './service-template/Code.gs?raw';

export function CreateGroup({ config, connection, initialSetup, onComplete, onBack }) {
  const [name, setName] = useState('');
  const [approved, setApproved] = useState(false);
  const [state, setState] = useState(initialSetup || null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [recoveredId, setRecoveredId] = useState('');
  const operation = useRef(null);
  const setupSession = useRef(null);
  useEffect(() => () => { operation.current?.abort(); setupSession.current = null; }, []);

  async function run(create) {
    if (operation.current || !approved) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(''); setMessage('');
    try {
      const session = setupSession.current && Date.now() < setupSession.current.expiresAt
        ? setupSession.current : await requestGoogleSession(config, true);
      controller.signal.throwIfAborted();
      const profile = await readProfile(session, { signal: controller.signal });
      if (profile.email.toLowerCase() !== connection.profile.email.toLowerCase()) throw new Error('Use the same Google account shown at the top of the console. No group was created with this different account.');
      setupSession.current = session;
      const service = createSetupService(serviceSource, session, { signal: controller.signal,
        onCheckpoint: next => { if (!controller.signal.aborted) setState(next); } });
      if (create) setAttempted(true);
      const next = create ? await service.create(name, profile.email)
        : await service.finish({ ...state, ...(recoveredId.trim() && !state.scriptId ? { scriptId: recoveredId.trim() } : {}) }, profile.email);
      controller.signal.throwIfAborted();
      setState(next);
      if (next.phase === 'ready') { setupSession.current = null; await onComplete(next.sheetId); }
      else if (!create) setMessage('Open Google approval below using the same account. After it confirms approval, return here and choose Finish setup.');
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof TypeError || error.name === 'TimeoutError'
        ? 'The connection stopped before setup could be confirmed. A sheet or script may already exist. Keep this page open and retry Finish setup, or select the same sheet after reconnecting. Do not start a second group to retry.' : error.message);
    } finally { if (!controller.signal.aborted) { setBusy(false); operation.current = null; } }
  }

  return <section className="editor setup-wizard" aria-label="Create a church-owned group">
    <p className="eyebrow">Guided setup / pilot</p><h1>{state ? `Set up ${state.name}` : 'Create your church group'}</h1>
    <p>Your private spreadsheet and its small Google-hosted service stay in your account. No central prayer database, paid hosting, or personal journal upload is involved.</p>
    <ol className="setup-steps"><li>Prepare your group</li><li>Approve Google access</li><li>Start managing prayers</li></ol>
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {!state && <label>Church or group name<input autoComplete="organization" maxLength={120} value={name} disabled={busy || attempted} onChange={event => setName(event.target.value)} /></label>}
    <aside className="notice"><strong>One-time Google setup</strong>
      <p>Open your Google settings and turn on <strong>Google Apps Script API</strong>, then return here. This permits approved apps to manage scripts; each app still needs your permission.</p>
      <a href="https://script.google.com/home/usersettings" target="_blank" rel="noopener noreferrer">Open Google script settings</a>
      <p>Creating a group asks for broader permission to create and manage Google scripts and deployments. Google does not limit that permission to this one script. Ordinary administration only needs access to files you choose.</p>
      <p>Use your church's Google account. Your sheet stays private, but approved prayers are readable by anyone holding the member invitation. Google and your administrators can access hosted data; it is not end-to-end encrypted.</p>
    </aside>
    <label className="check"><input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} />I have enabled Google script access and understand these permissions and privacy limits.</label>
    {state && <p><a href={`https://docs.google.com/spreadsheets/d/${state.sheetId}/edit`} target="_blank" rel="noopener noreferrer">Your group's private spreadsheet</a>. If you leave, choose this same spreadsheet in the console to resume.</p>}
    {state?.phase === 'authorizing' && !busy && <div className="notice"><h2>Approve this group's Google access</h2><p>Open the link below, choose <strong>{connection.profile.email}</strong>, and approve access for the church service. Once Google confirms completion, come back here.</p>
      <a className="button primary" href={setupEndpoint(state)} target="_blank" rel="noopener noreferrer">Open Google approval</a>
      <p>If Google shows an unverified-app warning, review the account, requested permissions, and generated script before deciding whether to proceed. An organization policy may prevent this setup.</p></div>}
    {state?.phase === 'creating-script' && !state.scriptId && <details><summary>Recover an interrupted script creation</summary><p>Open the private spreadsheet above, choose Extensions &gt; Apps Script, then Project Settings. If a bound project exists, enter its Script ID. The console checks that it belongs to this sheet before using it.</p><label>Recovered Script ID<input value={recoveredId} onChange={event => setRecoveredId(event.target.value)} disabled={busy} /></label></details>}
    {busy && <p role="status">{state?.phase === 'activating' ? 'Activating and checking your group...' : 'Preparing your group with Google...'} Keep this page open.</p>}
    {!state && attempted && !busy && <p className="notice">If no sheet was created, return to the group chooser to start again. If a sheet may have been created, find it in Google Drive and select it instead. The console does not automatically repeat creation after an uncertain result.</p>}
    <div className="actions">{!state ? <button className="primary" disabled={busy || attempted || !approved || !name.trim()} onClick={() => run(true)}>Prepare my group</button>
      : <button className="primary" disabled={busy || !approved} onClick={() => run(false)}>{state.phase === 'authorizing' || state.phase === 'activating' ? 'Finish setup' : 'Resume setup'}</button>}
      <button disabled={busy} onClick={onBack}>Back to group chooser</button></div>
    <p className="small muted">This guided flow is a pilot. Google permissions and organization policies vary. <a href="./setup.html#guided-creation" target="_blank" rel="noopener noreferrer">Setup help and recovery</a></p>
  </section>;
}
