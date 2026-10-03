import React, { StrictMode, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadGoogle, pickSpreadsheet, readConfig, requestGoogleSession } from './google.js';
import { GoogleAccessError, readGroup, readProfile } from './groupReader.js';
import './style.css';

const config = readConfig(import.meta.env);
const groupGuide = 'https://closetprayer.com/guides/groups/';

function PrayerCard({ row, inbox }) {
  return <article className="prayer-card">
    <div className="card-meta"><span className={`tag ${row.sharing === 'group-only' ? 'private' : ''}`}>
      {row.sharing === 'group-only' ? 'Group only' : 'Sharing permitted'}</span>
      <span>{inbox ? row.reviewStatus : `${row.publication} / ${row.status}`}</span></div>
    <h3>{row.title}</h3>
    <p className="description">{row.description || 'No description provided.'}</p>
    <div className="details"><span>Requested by {row.requestor || 'Not provided'}</span>
      <time dateTime={row.date}>{new Date(row.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time></div>
    {inbox && row.contact && <p className="contact">Administrator-only contact: {row.contact}</p>}
  </article>;
}

function Dashboard({ group, busy, onChoose, onRefresh }) {
  const [tab, setTab] = useState('inbox');
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const inbox = tab === 'inbox';
  const rows = (inbox ? group.inbox : group.requests).filter(row =>
    [row.title, row.description, row.requestor].some(value => value.toLocaleLowerCase().includes(search)));
  const pending = group.inbox.filter(row => row.reviewStatus === 'pending').length;
  const published = group.requests.filter(row => row.publication === 'published').length;
  return <>
    <section className="group-heading">
      <div><p className="eyebrow">Connected spreadsheet</p><h1>{group.name}</h1>
        <p className="muted">Last read {new Date(group.loadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Refresh to see new submissions.</p></div>
      <div className="actions"><button onClick={onRefresh} disabled={busy}>Refresh</button>
        <button onClick={onChoose} disabled={busy}>Change group</button></div>
    </section>
    <div className="stats" aria-label="Group summary">
      <div><strong>{pending}</strong><span>Awaiting review</span></div>
      <div><strong>{published}</strong><span>Published prayers</span></div>
      <div><strong>{group.requests.filter(row => row.sharing === 'group-only').length}</strong><span>Group-only prayers</span></div>
    </div>
    <aside className="notice"><strong>Read-only connection preview.</strong> Review your data here; continue approving and editing through the spreadsheet's Closet Prayer menu.
      <a href={`https://docs.google.com/spreadsheets/d/${group.id}/edit`} target="_blank" rel="noopener noreferrer">Open spreadsheet</a>
    </aside>
    <section className="board" aria-label="Group records">
      <div className="board-tools"><div className="tabs" aria-label="Record type">
        <button aria-pressed={inbox} onClick={() => setTab('inbox')}>Submissions <span>{group.inbox.length}</span></button>
        <button aria-pressed={!inbox} onClick={() => setTab('prayers')}>Prayers <span>{group.requests.length}</span></button>
      </div><label className="search">Search records<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title, description, or requestor" /></label></div>
      <p className="muted small">{inbox ? 'Includes pending, approved, and declined submissions. Contact details are for administrators only.' : 'Includes published prayers, drafts, and withdrawn requests. Sharing respects both visibility and recorded consent.'}</p>
      <div className="records">{rows.length ? rows.map(row => <PrayerCard key={row.id} row={row} inbox={inbox} />)
        : <div className="empty"><h3>{search ? 'No matching records' : inbox ? 'No submissions yet' : 'No prayer requests yet'}</h3>
          <p>{search ? 'Try another search.' : 'New records will appear after they are added to this spreadsheet and you refresh.'}</p></div>}</div>
      <div className="preview-actions"><button disabled>{inbox ? 'Approve submissions' : 'Edit prayers'}</button>
        <p>Console editing is not enabled in this milestone. No spreadsheet changes are made here.</p></div>
    </section>
  </>;
}

function App() {
  const [sdkReady, setSdkReady] = useState(false);
  const [connection, setConnection] = useState(null);
  const [group, setGroup] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const operation = useRef({ version: 0, controller: null });

  function begin(label) {
    operation.current.controller?.abort();
    const current = { version: operation.current.version + 1, controller: new AbortController() };
    operation.current = current;
    setBusy(label);
    setError('');
    return current;
  }
  function isCurrent(current) { return operation.current === current && !current.controller.signal.aborted; }
  function disconnect(message = '') {
    operation.current.controller?.abort();
    operation.current = { version: operation.current.version + 1, controller: null };
    setConnection(null);
    setGroup(null);
    setBusy('');
    setError(message);
  }
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
    try {
      const id = await pickSpreadsheet(config, connection.session.token, current.controller.signal);
      if (!id || !isCurrent(current)) return;
      setBusy('Reading group');
      const result = await readGroup(id, connection.session, { signal: current.controller.signal });
      if (isCurrent(current) && Date.now() < connection.session.expiresAt) setGroup(result);
    } catch (error) { report(error, current); }
    finally { if (isCurrent(current)) setBusy(''); }
  }

  async function refresh() {
    const current = begin('Refreshing group');
    try {
      const result = await readGroup(group.id, connection.session, { signal: current.controller.signal });
      if (isCurrent(current) && Date.now() < connection.session.expiresAt) setGroup(result);
    } catch (error) { report(error, current); }
    finally { if (isCurrent(current)) setBusy(''); }
  }

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="./"><span className="brand-mark" aria-hidden="true">CP</span><span>Closet Prayer<small>Administrator console</small></span></a>
      <div className="account">{connection ? <><span>{connection.profile.email}</span><button onClick={() => disconnect()}>Sign out</button></> : <span className="tag">Connection preview</span>}</div>
    </header>
    <main id="main">
      {error && <div className="error" role="alert">{error}</div>}
      {busy && <div className="progress" role="status">{busy}... <button onClick={() => disconnect()}>Cancel and disconnect</button></div>}
      {group ? <Dashboard key={group.id} group={group} busy={Boolean(busy)} onChoose={choose} onRefresh={refresh} /> : <div className="welcome-grid">
        <section className="welcome"><p className="eyebrow">Church-owned. People-centered.</p><h1>A place to care<br />for every request.</h1>
          <p className="lede">Connect your church's prayer group without handing its records to a central database.</p>
          <div className="principles"><div><span>01</span><p><strong>Your church keeps the data.</strong> Prayer requests stay in your Google spreadsheet.</p></div>
            <div><span>02</span><p><strong>Your team keeps control.</strong> Each administrator uses their own Google account and spreadsheet permissions.</p></div>
            <div><span>03</span><p><strong>Your journal stays personal.</strong> The console never opens or changes your local prayer journal.</p></div></div>
        </section>
        <section className="connection-panel" aria-label="Connect a group">
          <span className="tag">First milestone</span>
          <h2>{!config.ready ? 'Google setup required' : connection ? 'Choose your group' : 'Connect with Google'}</h2>
          <p>{!config.ready ? 'The console is ready for its Google Cloud configuration. Sign-in will be available after the site operator completes the setup guide.' : connection ? 'Select the spreadsheet already configured for your church. Your Google account must have Editor access.' : 'Use the Google account that owns your church spreadsheet, or one the owner has added as an Editor.'}</p>
          {config.ready ? <button className="primary" disabled={!sdkReady || Boolean(busy)} onClick={connection ? choose : connect}>
            {!sdkReady ? 'Loading Google...' : connection ? 'Choose a spreadsheet' : 'Connect Google account'}</button>
            : <a className="button primary" href="./setup.html">Set up the Google connection</a>}
          <p className="permission-note">Google permission covers files you select, not your entire Drive. That permission includes editing; this preview only reads data.</p>
          <hr /><h3>What works in this preview?</h3><p>Connect an account, select a group, and read its submissions and prayers. Approvals and editing still use the spreadsheet's Closet Prayer menu.</p>
          <a href={groupGuide}>Need to create a church group?</a>
        </section>
      </div>}
    </main>
    <footer><p>No central prayer database. No console data saved for offline use.</p><nav aria-label="Resources"><a href="./setup.html">Google setup</a><a href="./privacy.html">Privacy</a><a href="https://github.com/qwixilver/closet-prayer-console">Source code</a><a href="https://closetprayer.com/">Prayer journal</a></nav></footer>
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
