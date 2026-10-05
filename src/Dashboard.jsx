// SPDX-License-Identifier: GPL-3.0-only
import React, { useDeferredValue, useEffect, useRef, useState } from 'react';
import { rowRevision, verifyManagement } from './groupWriter.js';
import { submissionLinks } from './consoleProtocol.js';
import { memberLink } from './groupSetup.js';
import { InvitationQr } from './InvitationQr.jsx';

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function PrayerEditor({ edit, busy, onSave, onClose }) {
  const { row, type } = edit;
  const [fields, setFields] = useState(() => ({ title: row?.title || '', description: row?.description || '', requestor: row?.requestor || '',
    requestedAt: row?.date?.slice(0, 10) || localToday(), status: row?.status || 'requested',
    publication: type === 'approve' ? 'published' : row?.publication || 'draft',
    consent: row?.consent || row?.allowedSharing || 'group-only', visibility: row?.sharing || 'group-only' }));
  const attempt = useRef(null);
  const saving = useRef(false);
  const [started, setStarted] = useState(false);
  const [localError, setLocalError] = useState('');
  const [working, setWorking] = useState(false);
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const disabled = busy || working;
  const locked = disabled || started;
  function change(key, value) { setFields(old => ({ ...old, [key]: value, ...(key === 'consent' && value === 'group-only' ? { visibility: 'group-only' } : {}) })); }
  async function submit(event) {
    event.preventDefault();
    if (saving.current || busy) return;
    saving.current = true; setWorking(true); setLocalError('');
    try {
      if (!attempt.current) {
        const command = { version: 1, type, id: row?.id || crypto.randomUUID(),
          ...(row ? { expected: await rowRevision(row, type === 'approve' || type === 'decline') } : {}),
          ...(type !== 'decline' ? { prayer: { ...fields, requestedAt: row?.date?.slice(0, 10) === fields.requestedAt ? row.date : new Date(fields.requestedAt).toISOString() } } : {}) };
        attempt.current = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), command };
        setStarted(true);
      }
      if (await onSave(attempt.current)) onClose();
    } catch { setLocalError('This browser could not prepare the change. Check the date and use a secure HTTPS connection.'); }
    finally { saving.current = false; setWorking(false); }
  }
  return <section className="editor" aria-label={type === 'decline' ? 'Decline submission' : 'Prayer editor'}>
    <h2 ref={heading} tabIndex={-1}>{type === 'create' ? 'New prayer' : type === 'approve' ? 'Review and approve' : type === 'decline' ? 'Decline submission' : 'Edit prayer'}</h2>
    {localError && <p role="alert" className="error">{localError}</p>}
    <form onSubmit={submit}>
      {type === 'decline' ? <p>Decline <strong>{row.title}</strong>? It will remain in the private inbox as declined and will not be published.</p> : <>
        <fieldset disabled={locked}>
          <label>Prayer title<input required maxLength={200} value={fields.title} onChange={event => change('title', event.target.value)} /></label>
          <label>Prayer request<textarea rows={5} maxLength={10000} value={fields.description} onChange={event => change('description', event.target.value)} /></label>
          <label>Name to display<input maxLength={120} value={fields.requestor} onChange={event => change('requestor', event.target.value)} /></label>
          <div className="editor-columns"><label>Requested date<input type="date" required disabled={type === 'approve'} value={fields.requestedAt} onChange={event => change('requestedAt', event.target.value)} /></label>
            <label>Status<select aria-label="Status" value={fields.status} onChange={event => change('status', event.target.value)}><option value="requested">Requested</option><option value="answered">Answered</option></select></label>
            <label>Publication<select aria-label="Publication" disabled={type === 'approve'} value={fields.publication} onChange={event => change('publication', event.target.value)}><option value="draft">Draft</option><option value="published">Published</option><option value="withdrawn">Withdrawn</option></select></label>
            <label>Sharing<select aria-label="Sharing" value={fields.visibility} onChange={event => change('visibility', event.target.value)}><option value="group-only">Group only</option><option value="shareable" disabled={fields.consent !== 'shareable'}>Sharing permitted</option></select></label></div>
          {type === 'create' && <label className="check"><input type="checkbox" checked={fields.consent === 'shareable'} onChange={event => change('consent', event.target.checked ? 'shareable' : 'group-only')} />I have permission from the people concerned to allow sharing outside the group.</label>}
        </fieldset>
        <p className="small muted">{fields.consent === 'shareable' ? 'Consent permits sharing, but you can still restrict this prayer to the group.' : 'Consent limits this prayer to the group. Approval and editing cannot widen that permission.'} Administrator-only contact details are never copied into the published record automatically. Do not add private contact details to the wording.</p>
      </>}
      {started && <p className="notice">A save has been attempted. Retry checks the same change ID rather than creating another change. Closing this editor or signing out does not undo a change already sent to Google. Check the change history before starting again.</p>}
      <div className="actions"><button className="primary" disabled={disabled}>{disabled ? 'Saving...' : started ? 'Check / retry this save' : type === 'approve' ? 'Approve and publish' : type === 'decline' ? 'Confirm decline' : 'Save prayer'}</button>
        <button type="button" disabled={disabled} onClick={onClose}>Close editor</button></div>
    </form>
  </section>;
}

function SubmissionPanel({ group }) {
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const check = useRef(null);
  useEffect(() => () => check.current?.abort(), []);
  async function verify() {
    if (checking) return;
    setChecking(true); setError('');
    const controller = new AbortController();
    check.current = controller;
    try { await verifyManagement(group, { signal: controller.signal }); if (!controller.signal.aborted) setVerified(true); }
    catch (error) { if (!controller.signal.aborted) setError(error instanceof TypeError ? 'The church service could not be reached.' : error.message); }
    finally { if (!controller.signal.aborted) setChecking(false); }
  }
  const links = verified ? submissionLinks(group.management) : null;
  return <section className="submission-panel" aria-label="Submission form">
    <h2>Church website submissions</h2>
    <p>Use the existing public form for this group. Visitors do not need an administrator login. Requests enter this sheet's private Inbox for review.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!verified ? <button disabled={checking} onClick={verify}>{checking ? 'Checking service...' : 'Verify service and show embed'}</button> : <>
      <label>Public submission link<input readOnly value={links.link} onFocus={event => event.target.select()} /></label>
      {group.setup?.phase === 'ready' && group.setup.groupId === group.management.groupId && <div><label>Private member invitation (members only)<textarea aria-label="Private member invitation (members only)" readOnly rows={3} value={memberLink(group.setup)} onFocus={event => event.target.select()} /></label><p>Anyone holding this invitation can read approved group prayers and submit for review. Do not embed or publish this private link.</p><InvitationQr value={memberLink(group.setup)} /></div>}
      <label>Church website iframe<textarea aria-label="Church website iframe" readOnly rows={5} value={links.embed} onFocus={event => event.target.select()} /></label>
      <a className="button" href={links.link} target="_blank" rel="noopener noreferrer">Open submission form</a>
      <p className="small muted">The public link and iframe include only a submission credential, never a member invitation or Google access token. Anyone with the public link can submit, but cannot read prayers or approve requests. Submissions default to group-only and require consent. Test the iframe on your church's website before publishing it.</p>
    </>}
  </section>;
}

export function Dashboard({ group, busy, onChoose, onRefresh, onSave, onProcess }) {
  const [tab, setTab] = useState('inbox');
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState(null);
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const inbox = tab === 'inbox';
  const rows = (inbox ? group.inbox : group.requests).filter(row => [row.title, row.description, row.requestor].some(value => value.toLocaleLowerCase().includes(search)));
  const editable = Boolean(group.management);
  return <>
    <section className="group-heading"><div><p className="eyebrow">Connected spreadsheet</p><h1>{group.name}</h1>
      <p className="muted">Last read {new Date(group.loadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Refresh for new submissions.</p></div>
      <div className="actions"><button onClick={onRefresh} disabled={busy || Boolean(edit)}>Refresh</button><button onClick={onChoose} disabled={busy || Boolean(edit)}>Change group</button></div></section>
    <div className="stats" aria-label="Group summary"><div><strong>{group.inbox.filter(row => row.reviewStatus === 'pending').length}</strong><span>Awaiting review</span></div>
      <div><strong>{group.requests.filter(row => row.publication === 'published').length}</strong><span>Published prayers</span></div>
      <div><strong>{group.requests.filter(row => row.sharing === 'group-only').length}</strong><span>Group-only prayers</span></div></div>
    <aside className="notice">{editable ? <><strong>Church-owned management.</strong> Save through this console or the spreadsheet menu. Avoid direct cell edits, sorting, or deleting rows while someone is saving. Members receive published changes on their next successful sync.</>
      : <><strong>Script upgrade required for editing.</strong> This sheet is still readable. Update the church service and run Enable administrator console. <a href="./setup.html#management-upgrade" target="_blank" rel="noopener noreferrer">Enable management and submissions</a></>}
      <a href={`https://docs.google.com/spreadsheets/d/${group.id}/edit`} target="_blank" rel="noopener noreferrer">Open spreadsheet</a></aside>
    {edit && <PrayerEditor key={`${edit.type}-${edit.row?.id || 'new'}`} edit={edit} busy={busy} onSave={onSave} onClose={() => setEdit(null)} />}
    <section className="board" aria-label="Group records"><div className="board-tools"><div className="tabs" aria-label="Record type">
      <button aria-pressed={inbox} onClick={() => setTab('inbox')}>Submissions <span>{group.inbox.length}</span></button><button aria-pressed={!inbox} onClick={() => setTab('prayers')}>Prayers <span>{group.requests.length}</span></button></div>
      <label className="search">Search records<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title, description, or requestor" /></label></div>
      <p className="muted small">{inbox ? 'Includes pending, approved, and declined submissions. Contact details are for administrators only.' : 'Includes published prayers, drafts, and withdrawn requests. Sharing respects recorded consent.'}</p>
      {editable && <p><button disabled={busy || Boolean(edit)} onClick={() => setEdit({ type: 'create' })}>New prayer</button></p>}
      <div className="records">{rows.map(row => <article key={row.id} className="prayer-card">
        <div className="card-meta"><span className={`tag ${row.sharing === 'group-only' ? 'private' : ''}`}>{row.sharing === 'group-only' ? 'Group only' : 'Sharing permitted'}</span><span>{inbox ? row.reviewStatus : `${row.publication} / ${row.status}`}</span></div>
        <h3>{row.title}</h3><p className="description">{row.description || 'No description provided.'}</p>
        <div className="details"><span>Requested by {row.requestor || 'Not provided'}</span><time dateTime={row.date}>{new Date(row.date).toLocaleDateString(undefined, { timeZone: 'UTC' })}</time></div>
        {inbox && row.contact && <p className="contact">Administrator-only contact: {row.contact}</p>}
        {editable && <div className="actions card-actions">{inbox ? row.reviewStatus === 'pending' && <><button disabled={busy || Boolean(edit)} onClick={() => setEdit({ type: 'approve', row })}>Review and approve</button><button disabled={busy || Boolean(edit)} onClick={() => setEdit({ type: 'decline', row })}>Decline</button></>
          : <button disabled={busy || Boolean(edit)} onClick={() => setEdit({ type: 'update', row })}>Edit prayer</button>}</div>}
      </article>)}{!rows.length && <div className="empty"><h3>{search ? 'No matching records' : 'No records yet'}</h3><p>{search ? 'Try another search.' : 'Refresh after new records have been added.'}</p></div>}</div>
    </section>
    {editable && <>
      <SubmissionPanel key={JSON.stringify(group.management)} group={group} />
      <details className="command-history"><summary>Change history ({group.commands.length})</summary><p className="small muted">Pending means a change was queued but its result is not yet confirmed. Check it before creating another change. Pending changes expire after 24 hours. This is an operational history, not a tamper-proof audit log.</p>
        {group.commands.slice().reverse().map(command => <div key={command.id} className="history-row"><span><strong>{typeof command.command.prayer?.title === 'string' ? command.command.prayer.title : group.inbox.find(row => row.id === command.command.id)?.title || 'Prayer change'}</strong><br />{command.command.type} / {command.outcome} / {new Date(command.createdAt).toLocaleString()}</span>
          {command.outcome === 'pending' && <button disabled={busy || Boolean(edit)} onClick={() => onProcess(command.id)}>Check / finish pending change</button>}</div>)}
      </details>
    </>}
  </>;
}
