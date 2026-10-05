// SPDX-License-Identifier: GPL-3.0-only
import React, { StrictMode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadGoogle, pickSpreadsheet, readConfig, requestGoogleSession } from './google.js';
import { GoogleAccessError, readGroup, readProfile } from './groupReader.js';
import { appendConnectionStep, CONNECTION_STEPS, formatConnectionSteps } from './connectionDiagnostics.js';
import { PickerRecovery } from './PickerRecovery.jsx';
import { Dashboard } from './Dashboard.jsx';
import { CreateGroup } from './CreateGroup.jsx';
import { processPending, saveCommand } from './groupWriter.js';
import './style.css';

const config = readConfig(import.meta.env);
const groupGuide = 'https://closetprayer.com/guides/groups/';


function App() {
  const [sdkReady, setSdkReady] = useState(false);
  const [connection, setConnection] = useState(null);
  const [group, setGroup] = useState(null);
  const [creating, setCreating] = useState(false);
  const [groupSetup, setGroupSetup] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionSteps, setConnectionSteps] = useState([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnosticsReport = useRef(null);
  const errorReport = useRef(null);
  const operation = useRef({ version: 0, controller: null });

  function begin(label) {
    operation.current.controller?.abort();
    const current = { version: operation.current.version + 1, controller: new AbortController() };
    operation.current = current;
    setBusy(label);
    setError('');
    setNotice('');
    return current;
  }
  function isCurrent(current) { return operation.current === current && !current.controller.signal.aborted; }
  function disconnect(message = '') {
    operation.current.controller?.abort();
    operation.current = { version: operation.current.version + 1, controller: null };
    setConnection(null);
    setCreating(false); setGroupSetup(null);
    setGroup(null);
    setBusy('');
    setError(message);
    setNotice('');
    setConnectionSteps([]);
    setDiagnosticsOpen(false);
  }
  function closePicker() {
    setConnectionSteps(events => appendConnectionStep(events, 'picker-closed-by-user'));
    operation.current.controller?.abort();
    operation.current = { version: operation.current.version + 1, controller: null };
    setBusy('');
    setDiagnosticsOpen(true);
  }
  useEffect(() => {
    if (diagnosticsOpen && !busy) diagnosticsReport.current?.focus();
  }, [diagnosticsOpen, busy]);
  useEffect(() => { if (error) errorReport.current?.focus(); }, [error]);
  function report(error, current) {
    if (!isCurrent(current)) return;
    if (error instanceof GoogleAccessError && error.status === 401) disconnect(error.message);
    else {
      // A denied refresh must not leave previously downloaded private data visible.
      setGroup(null);
      setError(error.name === 'TimeoutError' ? 'Google took too long to respond. Please try again.' :
        error instanceof TypeError ? 'The connection failed. Check your network and try again.' : error.message || 'The connection could not be completed.');
    }
  }

  useEffect(() => {
    let active = true;
    if (config.ready) loadGoogle().then(() => { if (active) setSdkReady(true); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);

  const expire = useEffectEvent(() => {
    if (connection && Date.now() >= connection.session.expiresAt) disconnect('Your Google session expired. Connect again to continue.');
  });
  const leavePage = useEffectEvent(() => disconnect());
  useEffect(() => {
    window.addEventListener('pagehide', leavePage);
    window.addEventListener('pageshow', expire);
    document.addEventListener('visibilitychange', expire);
    return () => {
      window.removeEventListener('pagehide', leavePage);
      window.removeEventListener('pageshow', expire);
      document.removeEventListener('visibilitychange', expire);
    };
  }, []);
  useEffect(() => {
    if (!connection) return;
    const timer = setTimeout(expire, Math.max(0, connection.session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [connection]);

  async function connect() {
    const current = begin('Waiting for Google');
    try {
      const session = await requestGoogleSession(config);
      if (!isCurrent(current)) return;
      const profile = await readProfile(session, { signal: current.controller.signal });
      if (isCurrent(current) && Date.now() < session.expiresAt) setConnection({ session, profile });
      else if (isCurrent(current)) disconnect('Your Google session expired. Please connect again.');
    } catch (error) { report(error, current); }
    finally { if (isCurrent(current)) setBusy(''); }
  }

  async function choose() {
    if (!connection) return;
    if (Date.now() >= connection.session.expiresAt) { expire(); return; }
    const current = begin('Choosing a spreadsheet');
    setGroup(null);
    setConnectionSteps([]);
    setDiagnosticsOpen(false);
    const recordStep = code => {
      if (isCurrent(current)) setConnectionSteps(events => appendConnectionStep(events, code));
    };
    try {
      const id = await pickSpreadsheet(config, connection.session.token, current.controller.signal, recordStep);
      if (!id || !isCurrent(current)) return;
      recordStep('group-reading');
      setBusy('Reading group');
      const result = await readGroup(id, connection.session, { signal: current.controller.signal });
      if (isCurrent(current) && Date.now() < connection.session.expiresAt) {
        if (result.setup && result.setup.phase !== 'ready') { setGroupSetup(result.setup); setCreating(true); }
        else setGroup(result);
        recordStep('group-loaded');
      }
    } catch (error) { recordStep('connection-failed'); report(error, current); }
    finally { if (isCurrent(current)) setBusy(''); }
  }

  async function refresh() {
    const current = begin('Refreshing group');
    try {
      const result = await readGroup(group.id, connection.session, { signal: current.controller.signal });
      if (isCurrent(current) && Date.now() < connection.session.expiresAt) {
        if (result.setup && result.setup.phase !== 'ready') { setGroup(null); setGroupSetup(result.setup); setCreating(true); }
        else setGroup(result);
      }
    } catch (error) { report(error, current); }
    finally { if (isCurrent(current)) setBusy(''); }
  }

  async function created(sheetId) {
    const current = begin('Opening your group');
    try {
      const result = await readGroup(sheetId, connection.session, { signal: current.controller.signal });
      if (result.setup?.phase !== 'ready') throw new Error('Setup is not yet complete. Select the same spreadsheet to resume.');
      if (isCurrent(current)) { setGroup(result); setCreating(false); setGroupSetup(null); setNotice('Your group is ready. Create a prayer, invite members, or get the website submission form below.'); }
    } catch (error) { report(error, current); }
    finally { if (isCurrent(current)) setBusy(''); }
  }

  async function manage(change, resume = false) {
    if (!connection || busy) return false;
    if (Date.now() >= connection.session.expiresAt) { expire(); return false; }
    const current = begin('Saving changes');
    try {
      const options = { signal: current.controller.signal };
      const updated = await (resume ? processPending(group, change, connection.session, options) : saveCommand(group, change, connection.session, options));
      if (!isCurrent(current) || Date.now() >= connection.session.expiresAt) return false;
      setGroup(updated); setNotice('Change applied and spreadsheet reloaded.'); return true;
    } catch (error) {
      if (!isCurrent(current)) return false;
      if (error instanceof GoogleAccessError && [401, 403, 404].includes(error.status)) {
        report(new GoogleAccessError(`${error.message} A change already sent may still finish. Check history after access is restored.`, error.status), current);
      }
      else setError(error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name)
        ? 'The save result is uncertain. A queued change may still exist. Retry this same save, or close the editor and refresh the change history before creating another change.'
        : `${error.message} If a change was queued, check its history before creating another change.`);
      return false;
    } finally { if (isCurrent(current)) setBusy(''); }
  }

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="./"><span className="brand-mark" aria-hidden="true">CP</span><span>Closet Prayer<small>Administrator console</small></span></a>
      <div className="account">{connection ? <><span>{connection.profile.email}</span><button onClick={() => disconnect()}>Sign out</button></> : <span className="tag">Church-owned groups</span>}</div>
    </header>
    <main id="main">
      {error && <div ref={errorReport} tabIndex={-1} className="error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {busy && <div className="progress" role="status">{busy}... <button onClick={() => disconnect()}>Cancel and disconnect</button></div>}
      {busy === 'Saving changes' && <p className="notice">Disconnecting does not undo a change already sent to Google. Reconnect and check change history if the result is uncertain.</p>}
      {creating && connection ? <CreateGroup config={config} connection={connection} initialSetup={groupSetup} onComplete={created} onBack={() => { setCreating(false); setGroupSetup(null); }} /> : group ? <Dashboard key={group.id} group={group} busy={Boolean(busy)} onChoose={choose} onRefresh={refresh} onSave={manage} onProcess={id => manage(id, true)} /> : <div className="welcome-grid">
        <section className="welcome"><p className="eyebrow">Church-owned. People-centered.</p><h1>A place to care<br />for every request.</h1>
          <p className="lede">Connect your church's prayer group without handing its records to a central database.</p>
          <div className="principles"><div><span>01</span><p><strong>Your church keeps the data.</strong> Prayer requests stay in your Google spreadsheet.</p></div>
            <div><span>02</span><p><strong>Your team keeps control.</strong> Each administrator uses their own Google account and spreadsheet permissions.</p></div>
            <div><span>03</span><p><strong>Your journal stays personal.</strong> The console never opens or changes your local prayer journal.</p></div></div>
        </section>
        <section className="connection-panel" aria-label="Connect a group">
          <span className="tag">Group management</span>
          <h2>{!config.ready ? 'Google setup required' : connection ? 'Choose your group' : 'Connect with Google'}</h2>
          <p>{!config.ready ? 'The console is ready for its Google Cloud configuration. Sign-in will be available after the site operator completes the setup guide.' : connection ? 'Create a church-owned group, or choose an existing spreadsheet. Existing groups require Editor access.' : 'Use your church Google account, or one the church owner has added as an Editor.'}</p>
          {config.ready ? <button className="primary" disabled={!sdkReady || Boolean(busy)} onClick={connection ? choose : connect}>
            {!sdkReady ? 'Loading Google...' : connection ? 'Choose a spreadsheet' : 'Connect Google account'}</button>
            : <a className="button primary" href="./setup.html">Set up the Google connection</a>}
          {connection && <button disabled={Boolean(busy)} onClick={() => { setGroupSetup(null); setCreating(true); }}>Create a new group</button>}
          <p className="permission-note">Ordinary administration covers files you select, not your entire Drive. Creating a group asks separately for broader Google script-management permission. Older sheets remain read-only until upgraded.</p>
          <p className="permission-note">Confirm the spreadsheet with the picker's Select or Open button. Your sign-in and chosen group remain only until you leave or reload the page.</p>
          {config.ready && <p className="permission-note">Google picker stuck in Brave? <a href="./setup.html#brave-cookies" target="_blank" rel="noopener noreferrer">Browser cookie help</a> explains a site-only workaround without turning Shields off.</p>}
          <hr /><h3>Manage your church group</h3><p>Review submissions, create and edit prayers, publish or withdraw requests, and get your church website's submission form.</p>
          <a href={groupGuide}>Need to create a church group?</a>
        </section>
      </div>}
      {busy === 'Choosing a spreadsheet' && connectionSteps.some(step => step.code === 'picker-waiting') && <PickerRecovery onClose={closePicker} />}
      {connectionSteps.length > 0 && <details className="connection-diagnostics" open={diagnosticsOpen} onToggle={event => setDiagnosticsOpen(event.currentTarget.open)}>
        <summary>Connection diagnostics</summary>
        <p role="status">{CONNECTION_STEPS[connectionSteps.at(-1).code]}</p>
        <p className="small muted">If selection stalls, a Closet Prayer recovery prompt appears above Google's picker after 45 seconds. Choose Close picker and show diagnostics, then copy this report before refreshing. It contains no keys, tokens, email addresses, file names, file IDs, or prayer text.</p>
        {connectionSteps.some(step => step.code === 'picker-waiting') && !connectionSteps.some(step => step.code === 'picker-selection-received') && <p className="small muted">No confirmed selection was received. Cookie blocking can cause this in Brave; see <a href="./setup.html#brave-cookies" target="_blank" rel="noopener noreferrer">Brave cookie help</a> before changing settings. The console cannot detect your cookie settings, and a missing callback alone does not identify the cause. For other cases, see <a href="./setup.html#picker-stalled" target="_blank" rel="noopener noreferrer">picker troubleshooting</a>. Keep your spreadsheet private and API key restricted.</p>}
        <textarea ref={diagnosticsReport} aria-label="Connection diagnostics report" readOnly rows={8} value={formatConnectionSteps(connectionSteps)} onFocus={event => event.target.select()} />
      </details>}
    </main>
    <footer><p>No central prayer database. No console data saved for offline use.</p><nav aria-label="Resources"><a href="./setup.html">Google setup</a><a href="./privacy.html">Privacy</a><a href="https://github.com/qwixilver/closet-prayer-console">Source code</a><a href="./LICENSE.txt">GPL-3.0</a><a href="./THIRD_PARTY_NOTICES.txt">Third-party notices</a><a href="https://closetprayer.com/">Prayer journal</a></nav></footer>
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
