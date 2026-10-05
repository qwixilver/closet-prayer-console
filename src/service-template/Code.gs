// Bind this script to a private church-owned Google Sheet. See docs/groups.md.
// Administrator commands originate in the private sheet via Google-authorized writes.
// Public requests may process an existing command ID, never supply a command.
const CP_REQUEST_HEADERS = ['id', 'publication', 'visibility', 'consent', 'title', 'description', 'requestor', 'requestedAt', 'status'];
const CP_INBOX_HEADERS = ['id', 'receivedAt', 'title', 'description', 'requestor', 'contact', 'allowedSharing', 'reviewStatus'];
const CP_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{43}$/;
const CP_UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Closet Prayer')
    .addItem('Configure group', 'configureGroup')
    .addItem('Enable administrator console', 'enableAdministratorConsole')
    .addItem('Add draft prayer', 'addDraftPrayer')
    .addItem('Publish selected requests', 'publishSelectedRequests')
    .addItem('Decline selected submissions', 'declineSelectedSubmissions')
    .addItem('Withdraw selected prayers', 'withdrawSelectedPrayers')
    .addItem('Mark selected prayers answered', 'answerSelectedPrayers')
    .addItem('Restrict selected prayers to group', 'restrictSelectedPrayers')
    .addToUi();
}

function configureGroup() {
  const ui = SpreadsheetApp.getUi();
  const prompt = ui.prompt('Configure group', 'Paste the private setup code generated in the Closet Prayer administrator console.', ui.ButtonSet.OK_CANCEL);
  if (prompt.getSelectedButton() !== ui.Button.OK) return;
  const config = JSON.parse(prompt.getResponseText());
  if (config.version !== 1 || !CP_UUID_PATTERN.test(config.groupId || '') ||
      !CP_TOKEN_PATTERN.test(config.memberToken || '') || !CP_TOKEN_PATTERN.test(config.submissionToken || '') ||
      config.memberToken === config.submissionToken) throw new Error('Invalid setup code.');
  const name = cpText_(config.name, 120, true);
  const properties = PropertiesService.getScriptProperties();
  const previous = properties.getProperty('CP_GROUP_ID');
  if (previous && previous !== config.groupId) throw new Error('This sheet already belongs to another group. Use a new spreadsheet for a new group.');
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  cpEnsureSheet_(sheet, 'Requests', CP_REQUEST_HEADERS);
  cpEnsureSheet_(sheet, 'Inbox', CP_INBOX_HEADERS);
  properties.setProperties({ CP_GROUP_ID: config.groupId.toLowerCase(), CP_GROUP_NAME: name,
    CP_SHEET_ID: sheet.getId(), CP_MEMBER_HASH: cpHash_(config.memberToken),
    CP_SUBMIT_HASH: cpHash_(config.submissionToken) });
  ui.alert('Group configured. Keep this spreadsheet private. Deploy the web app as yourself with access set to Anyone, then create invitations in Closet Prayer.');
}

function cpEnsureSheet_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (!sheet.getLastRow()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  cpReadRows_(sheet, headers);
  return sheet;
}

function cpSheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty('CP_SHEET_ID');
  if (!id) throw new Error('Group is not configured.');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) throw new Error('Missing group sheet.');
  return sheet;
}

function cpReadRows_(sheet, headers) {
  if (sheet.getLastRow() > 2001) throw new Error('Archive old rows before continuing.');
  const values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), headers.length).getValues();
  if (JSON.stringify(values[0]) !== JSON.stringify(headers)) throw new Error('The sheet columns have changed. Restore the template headers.');
  return values.slice(1).map((cells, index) => {
    const row = { sheetRow: index + 2 };
    headers.forEach((name, col) => { row[name] = cells[col]; });
    return row;
  });
}

function cpText_(value, limit, required) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error('Invalid text.');
  return value;
}

function cpCell_(value) {
  // Untrusted submissions must remain literal text, never spreadsheet formulas.
  return typeof value === 'string' && /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
}

function cpHash_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)).replace(/=+$/, '');
}

function cpCredentialMatches_(token, expected) {
  if (typeof token !== 'string' || !CP_TOKEN_PATTERN.test(token) || !expected) return false;
  const actual = cpHash_(token);
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function cpGroup_() {
  const properties = PropertiesService.getScriptProperties();
  return { id: properties.getProperty('CP_GROUP_ID'), name: properties.getProperty('CP_GROUP_NAME') };
}

function cpResult_(data) {
  return Object.assign({ protocol: 'cp-group', version: 1, ok: true, group: cpGroup_(), capabilities: { memberSubmissions: true } }, data);
}

function doGet() {
  if (typeof CP_INSTALL !== 'undefined') {
    try {
      cpInstall_();
      return ContentService.createTextOutput('Google approval completed. Return to the Closet Prayer console and choose Finish setup.');
    } catch (error) {
      return ContentService.createTextOutput('Setup could not be verified. Return to the Closet Prayer console. No group data was replaced.');
    }
  }
  return ContentService.createTextOutput('Closet Prayer group service. Use your invitation in the app.');
}

// Only generated, owner-only authorization deployments include CP_INSTALL.
// Configuration is fixed in the private script, never accepted from an HTTP request.
function cpInstall_() {
  return cpWithLock_(function () {
    const install = CP_INSTALL;
    const spreadsheet = SpreadsheetApp.openById(install.sheetId);
    const setup = spreadsheet.getSheetByName('GroupSetup');
    if (!setup) throw new Error('Missing setup receipt.');
    const record = JSON.parse(setup.getRange(2, 2).getValues()[0][0]);
    if (record.protocol !== 'cp-setup' || record.version !== 1 || record.installId !== install.installId ||
        record.groupId !== install.groupId || record.name !== install.name || record.phase !== 'authorizing' ||
        record.memberToken !== install.memberToken || record.submissionToken !== install.submissionToken ||
        !CP_UUID_PATTERN.test(install.groupId) || !CP_TOKEN_PATTERN.test(install.memberToken) ||
        !CP_TOKEN_PATTERN.test(install.submissionToken) || install.memberToken === install.submissionToken) throw new Error('Setup mismatch.');
    cpText_(install.name, 120, true);
    const properties = PropertiesService.getScriptProperties();
    const previous = properties.getProperty('CP_GROUP_ID');
    if (previous && (previous !== install.groupId || properties.getProperty('CP_INSTALL_ID') !== install.installId)) throw new Error('Already configured.');
    const requests = cpEnsureSheet_(spreadsheet, 'Requests', CP_REQUEST_HEADERS);
    const inbox = cpEnsureSheet_(spreadsheet, 'Inbox', CP_INBOX_HEADERS);
    if (!previous && (requests.getLastRow() > 1 || inbox.getLastRow() > 1)) throw new Error('Not empty.');
    // Prove that the advanced service is authorized before recording success.
    Sheets.Spreadsheets.get(install.sheetId, { fields: 'spreadsheetId' });
    properties.setProperties({ CP_GROUP_ID: install.groupId, CP_GROUP_NAME: install.name,
      CP_SHEET_ID: install.sheetId, CP_MEMBER_HASH: cpHash_(install.memberToken),
      CP_SUBMIT_HASH: cpHash_(install.submissionToken), CP_CONSOLE_VERSION: '1', CP_INSTALL_ID: install.installId });
    setup.getRange(3, 1, 1, 2).setNumberFormat('@').setValues([['authorized', install.installId]]);
  });
}

function doPost(event) {
  let result;
  try {
    const body = event && event.postData && event.postData.contents;
    if (typeof body !== 'string' || body.length > 20000) throw new Error('Invalid request.');
    result = cpHandleRequest_(JSON.parse(body));
  } catch (error) {
    // Do not return exception details or log request bodies containing credentials/prayers.
    result = { protocol: 'cp-group', version: 1, ok: false, code: 'service-error' };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function cpHandleRequest_(request) {
  const properties = PropertiesService.getScriptProperties();
  const deny = { protocol: 'cp-group', version: 1, ok: false, code: 'access-denied' };
  if (!request || request.protocol !== 'cp-group' || request.version !== 1 ||
      request.groupId !== properties.getProperty('CP_GROUP_ID')) return deny;
  if (request.action === 'sync') {
    if (!cpCredentialMatches_(request.token, properties.getProperty('CP_MEMBER_HASH'))) return deny;
    return cpWithLock_(function () { return cpSnapshot_(request.revision); });
  }
  if (request.action === 'submit-info' || request.action === 'submit') {
    if (!cpCredentialMatches_(request.token, properties.getProperty('CP_SUBMIT_HASH'))) return deny;
    if (request.action === 'submit-info') return cpResult_({});
    return cpSubmit_(request);
  }
  if (request.action === 'member-submit-info' || request.action === 'member-submit') {
    if (!cpCredentialMatches_(request.token, properties.getProperty('CP_MEMBER_HASH'))) return deny;
    if (request.action === 'member-submit-info') return cpResult_({});
    // Members use their existing invitation. Never return the public submission key.
    return cpSubmit_(request);
  }
  if (request.action === 'console-info' || request.action === 'console-process') {
    if (!cpCredentialMatches_(request.token, properties.getProperty('CP_SUBMIT_HASH')) ||
        properties.getProperty('CP_CONSOLE_VERSION') !== '1') return deny;
    if (request.action === 'console-info') return cpResult_({ consoleVersion: 1, sheetId: properties.getProperty('CP_SHEET_ID') });
    return cpProcessCommand_(request.requestId);
  }
  return deny;
}

function cpSnapshot_(previousRevision) {
  const ids = new Set();
  const prayers = cpReadRows_(cpSheet_('Requests'), CP_REQUEST_HEADERS)
    .filter(row => row.publication === 'published')
    .map(row => {
      if (!CP_UUID_PATTERN.test(row.id) || ids.has(row.id) ||
          !['requested', 'answered'].includes(row.status) ||
          !['shareable', 'group-only'].includes(row.visibility)) throw new Error('Invalid published row.');
      ids.add(row.id);
      return { id: row.id,
        name: cpText_(row.title, 200, true), description: cpText_(row.description, 10000, false),
        requestor: cpText_(row.requestor, 120, false), requestedAt: new Date(row.requestedAt).toISOString(),
        status: row.status,
        visibility: row.visibility === 'shareable' && row.consent === 'shareable' ? 'shareable' : 'group-only' };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (prayers.length > 1000) throw new Error('Too many published prayers.');
  const revision = cpHash_(JSON.stringify({ group: cpGroup_(), prayers: prayers }));
  if (revision === previousRevision) return cpResult_({ revision: revision, unchanged: true });
  const result = cpResult_({ revision: revision, complete: true, prayers: prayers });
  if (Utilities.newBlob(JSON.stringify(result)).getBytes().length > 2000000) throw new Error('Published prayers are too large.');
  return result;
}

function cpSubmit_(request) {
  const submission = request.submission;
  if (!CP_UUID_PATTERN.test(request.requestId || '') || !submission || submission.consent !== true ||
      submission.website || !['group-only', 'shareable'].includes(submission.visibility)) throw new Error('Invalid submission.');
  const values = [request.requestId, new Date().toISOString(), cpText_(submission.name, 200, true),
    cpText_(submission.description, 10000, true), cpText_(submission.requestor, 120, false),
    cpText_(submission.contact, 200, false), submission.visibility, 'pending'];
  return cpWithLock_(function () {
    const sheet = cpSheet_('Inbox');
    const rows = cpReadRows_(sheet, CP_INBOX_HEADERS);
    // A retry after a lost response must not create another submission.
    if (rows.some(row => row.id === request.requestId)) return cpResult_({ accepted: true });
    if (rows.length >= 2000) throw new Error('Inbox full.');
    const properties = PropertiesService.getScriptProperties();
    const hour = new Date().toISOString().slice(0, 13);
    const day = hour.slice(0, 10);
    const counters = JSON.parse(properties.getProperty('CP_SUBMIT_LIMITS') || '{}');
    const hourCount = counters.hour === hour ? Number(counters.hourCount) || 0 : 0;
    const dayCount = counters.day === day ? Number(counters.dayCount) || 0 : 0;
    if (hourCount >= 20 || dayCount >= 100) throw new Error('Submission limit reached.');
    properties.setProperty('CP_SUBMIT_LIMITS', JSON.stringify({ hour: hour, day: day, hourCount: hourCount + 1, dayCount: dayCount + 1 }));
    sheet.appendRow(values.map(cpCell_));
    SpreadsheetApp.flush();
    return cpResult_({ accepted: true });
  });
}

function cpWithLock_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(4000)) throw new Error('Group busy.');
  try { return action(); } finally {
    // Finish any buffered spreadsheet-menu writes before another writer enters.
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

function cpSelection_(name, headers) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (sheet.getName() !== name) throw new Error('Select rows in the ' + name + ' tab first.');
  const range = sheet.getActiveRange();
  return cpReadRows_(sheet, headers).filter(row => row.sheetRow >= range.getRow() && row.sheetRow <= range.getLastRow());
}

function addDraftPrayer() {
  cpWithLock_(function () {
    const sheet = cpSheet_('Requests');
    cpReadRows_(sheet, CP_REQUEST_HEADERS);
    if (sheet.getLastRow() >= 2001) throw new Error('Archive old rows first.');
    sheet.appendRow([Utilities.getUuid(), 'draft', 'group-only', 'group-only', 'New prayer request', '', '', new Date().toISOString(), 'requested']);
    SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
    sheet.getRange(sheet.getLastRow(), 5).activate();
  });
}

function publishSelectedRequests() {
  cpWithLock_(function () {
    const active = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    const target = cpSheet_('Requests');
    const existing = cpReadRows_(target, CP_REQUEST_HEADERS);
    if (active.getName() === 'Requests') {
      const rows = cpSelection_('Requests', CP_REQUEST_HEADERS);
      rows.forEach(row => {
        cpText_(row.title, 200, true);
        cpText_(row.description, 10000, false);
        if (!CP_UUID_PATTERN.test(row.id) || !['requested', 'answered'].includes(row.status) || !Number.isFinite(new Date(row.requestedAt).getTime())) throw new Error('Invalid draft prayer.');
      });
      rows.forEach(row => target.getRange(row.sheetRow, 2).setValue('published'));
    } else {
      const rows = cpSelection_('Inbox', CP_INBOX_HEADERS).filter(row => row.reviewStatus === 'pending');
      if (existing.length + rows.filter(row => !existing.some(item => item.id === row.id)).length > 2000) throw new Error('Archive old requests first.');
      rows.forEach(row => {
        const visibility = row.allowedSharing === 'shareable' ? 'shareable' : 'group-only';
        const values = [row.id, 'published', visibility, visibility, row.title, row.description, row.requestor, row.receivedAt, 'requested'].map(cpCell_);
        const previous = existing.find(item => item.id === row.id);
        if (previous) target.getRange(previous.sheetRow, 1, 1, values.length).setValues([values]);
        else target.appendRow(values);
        active.getRange(row.sheetRow, 8).setValue('approved');
      });
    }
    SpreadsheetApp.flush();
  });
}

function declineSelectedSubmissions() {
  cpWithLock_(function () {
    const sheet = cpSheet_('Inbox');
    cpSelection_('Inbox', CP_INBOX_HEADERS).forEach(row => sheet.getRange(row.sheetRow, 8).setValue('declined'));
  });
}

function cpUpdateSelected_(column, value) {
  cpWithLock_(function () {
    const sheet = cpSheet_('Requests');
    cpSelection_('Requests', CP_REQUEST_HEADERS).forEach(row => sheet.getRange(row.sheetRow, column).setValue(value));
    SpreadsheetApp.flush();
  });
}

function withdrawSelectedPrayers() { cpUpdateSelected_(2, 'withdrawn'); }
function answerSelectedPrayers() { cpUpdateSelected_(9, 'answered'); }
function restrictSelectedPrayers() { cpUpdateSelected_(3, 'group-only'); }

const CP_CONSOLE_HEADERS = ['key', 'value'];
const CP_COMMAND_HEADERS = ['id', 'createdAt', 'command', 'outcome', 'completedAt'];

function enableAdministratorConsole() {
  const ui = SpreadsheetApp.getUi();
  const prompt = ui.prompt('Enable administrator console', 'Paste this group\'s PUBLIC submission link (not its private member invitation). Update this script and its manifest, enable the Google Sheets advanced service, and update the existing web deployment first.', ui.ButtonSet.OK_CANCEL);
  if (prompt.getSelectedButton() !== ui.Button.OK) return;
  const input = prompt.getResponseText().trim();
  const code = input.indexOf('#group=') >= 0 ? input.split('#group=')[1] : input;
  const parts = code.split('.');
  const properties = PropertiesService.getScriptProperties();
  if (parts.length !== 5 || parts[0] !== 'CPG1' || parts[1] !== 's' ||
      !/^[a-zA-Z0-9_-]{16,160}$/.test(parts[2]) || parts[3] !== properties.getProperty('CP_GROUP_ID') ||
      !cpCredentialMatches_(parts[4], properties.getProperty('CP_SUBMIT_HASH'))) throw new Error('Use the public submission link for this configured group.');
  cpWithLock_(function () {
    const spreadsheet = SpreadsheetApp.openById(properties.getProperty('CP_SHEET_ID'));
    // A read proves the advanced service is authorized before enabling writes.
    Sheets.Spreadsheets.get(spreadsheet.getId(), { fields: 'spreadsheetId' });
    const settings = cpEnsureSheet_(spreadsheet, 'ConsoleSettings', CP_CONSOLE_HEADERS);
    cpEnsureSheet_(spreadsheet, 'ConsoleCommands', CP_COMMAND_HEADERS);
    settings.getRange(2, 1, 5, 2).setNumberFormat('@').setValues([
      ['protocol', 'cp-console'], ['version', '1'], ['groupId', parts[3]],
      ['endpoint', 'https://script.google.com/macros/s/' + parts[2] + '/exec'], ['submissionToken', parts[4]]
    ]);
    SpreadsheetApp.flush();
    properties.setProperty('CP_CONSOLE_VERSION', '1');
  });
  ui.alert('Console enabled. Select this sheet at console.closetprayer.com. Keep every tab private. Manage through the console or the Sheet menu; avoid direct cell/row edits while someone is saving. Re-run this setup if you rotate the public submission key.');
}

function cpRevisionDate_(value) {
  // The Sheets REST API exposes native dates as timezone-free serial numbers.
  // Match that wall-clock representation for hashes, but preserve actual dates on save.
  if (value instanceof Date) {
    const spreadsheet = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('CP_SHEET_ID'));
    return Utilities.formatDate(value, spreadsheet.getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  }
  return new Date(value).toISOString();
}

function cpRowRevision_(row, headers) {
  return cpHash_(JSON.stringify(headers.map(function (key) {
    return key === 'requestedAt' || key === 'receivedAt' ? cpRevisionDate_(row[key]) : row[key];
  })));
}

function cpCommandError_(code) { const error = new Error(code); error.commandCode = code; throw error; }

function cpUniqueRows_(sheet, headers) {
  const ids = new Set();
  return cpReadRows_(sheet, headers).filter(function (row) {
    if (headers.every(function (key) { return row[key] === '' || row[key] == null; })) return false;
    if (!CP_UUID_PATTERN.test(row.id || '') || ids.has(row.id.toLowerCase())) cpCommandError_('rejected');
    ids.add(row.id.toLowerCase());
    return true;
  });
}

function cpCells_(values) {
  // stringValue, unlike user-entered text, cannot execute a spreadsheet formula.
  return values.map(function (value) { return { userEnteredValue: { stringValue: String(value) } }; });
}

function cpWriteCells_(sheet, row, column, values) {
  return { updateCells: { start: { sheetId: sheet.getSheetId(), rowIndex: row - 1, columnIndex: column - 1 },
    rows: [{ values: cpCells_(values) }], fields: 'userEnteredValue' } };
}

function cpPrayerValues_(command, consent, requestedAt) {
  const prayer = command.prayer;
  if (!prayer || !['draft', 'published', 'withdrawn'].includes(prayer.publication) ||
      !['requested', 'answered'].includes(prayer.status) || !['group-only', 'shareable'].includes(prayer.visibility) ||
      !['group-only', 'shareable'].includes(consent) || (prayer.visibility === 'shareable' && consent !== 'shareable')) cpCommandError_('rejected');
  if (!requestedAt || !Number.isFinite(new Date(requestedAt).getTime())) cpCommandError_('rejected');
  return [command.id, prayer.publication, prayer.visibility, consent,
    cpText_(prayer.title, 200, true), cpText_(prayer.description, 10000, false),
    cpText_(prayer.requestor, 120, false), new Date(requestedAt).toISOString(), prayer.status];
}

function cpPrepareCommand_(command) {
  if (!command || command.version !== 1 || !CP_UUID_PATTERN.test(command.id || '') ||
      !['create', 'update', 'approve', 'decline'].includes(command.type)) cpCommandError_('rejected');
  const requests = cpSheet_('Requests'), inbox = cpSheet_('Inbox');
  const prayers = cpUniqueRows_(requests, CP_REQUEST_HEADERS);
  const submissions = cpUniqueRows_(inbox, CP_INBOX_HEADERS);
  const previous = prayers.find(function (row) { return row.id.toLowerCase() === command.id.toLowerCase(); });
  const submission = submissions.find(function (row) { return row.id.toLowerCase() === command.id.toLowerCase(); });
  let values;
  const changes = [];
  if (command.type === 'create') {
    if (previous || submission) cpCommandError_('conflict');
    values = cpPrayerValues_(command, command.prayer && command.prayer.consent, command.prayer && command.prayer.requestedAt);
  } else {
    const source = command.type === 'update' ? previous : submission;
    const headers = command.type === 'update' ? CP_REQUEST_HEADERS : CP_INBOX_HEADERS;
    if (!source || command.expected !== cpRowRevision_(source, headers)) cpCommandError_('conflict');
    if (command.type === 'update') {
      let requestedAt = command.prayer && command.prayer.requestedAt;
      if (previous.requestedAt instanceof Date && requestedAt === cpRevisionDate_(previous.requestedAt)) requestedAt = previous.requestedAt;
      values = cpPrayerValues_(command, previous.consent, requestedAt);
    } else {
      if (submission.reviewStatus !== 'pending' || previous) cpCommandError_('conflict');
      if (command.type === 'approve') {
        if (previous) cpCommandError_('conflict');
        if (!command.prayer || command.prayer.publication !== 'published') cpCommandError_('rejected');
        values = cpPrayerValues_(command, submission.allowedSharing, submission.receivedAt);
      }
      changes.push(cpWriteCells_(inbox, submission.sheetRow, 8, [command.type === 'approve' ? 'approved' : 'declined']));
    }
  }
  if (values) {
    if (command.type === 'update') changes.push(cpWriteCells_(requests, previous.sheetRow, 1, values));
    else {
      if (requests.getLastRow() >= 2001) cpCommandError_('rejected');
      changes.push({ appendCells: { sheetId: requests.getSheetId(), rows: [{ values: cpCells_(values) }], fields: 'userEnteredValue' } });
    }
    // Enforce the member-feed limits before publishing, not after breaking sync.
    const candidate = prayers.filter(function (row) { return row.id.toLowerCase() !== command.id.toLowerCase(); });
    candidate.push(Object.fromEntries(CP_REQUEST_HEADERS.map(function (key, index) { return [key, values[index]]; })));
    const published = candidate.filter(function (row) { return row.publication === 'published'; });
    if (published.length > 1000 || Utilities.newBlob(JSON.stringify(published)).getBytes().length > 1800000) cpCommandError_('rejected');
  }
  return changes;
}

function cpProcessCommand_(id) {
  if (!CP_UUID_PATTERN.test(id || '')) throw new Error('Invalid command ID.');
  return cpWithLock_(function () {
    const sheet = cpSheet_('ConsoleCommands');
    const rows = cpReadRows_(sheet, CP_COMMAND_HEADERS).filter(function (row) { return row.id === id; });
    if (!rows.length) return cpResult_({ outcome: 'not-found' });
    if (rows.some(function (row) { return row.command !== rows[0].command; })) return cpResult_({ outcome: 'rejected' });
    const terminal = rows.find(function (row) { return ['applied', 'conflict', 'rejected', 'expired'].includes(row.outcome); });
    if (terminal) return cpResult_({ outcome: terminal.outcome });
    let outcome = 'applied', changes = [];
    try {
      if (rows.some(function (row) { return row.outcome !== 'pending'; }) || typeof rows[0].command !== 'string' || rows[0].command.length > 16000) cpCommandError_('rejected');
      const age = Date.now() - new Date(rows[0].createdAt).getTime();
      if (!Number.isFinite(age) || age < -300000 || age > 86400000) cpCommandError_('expired');
      changes = cpPrepareCommand_(JSON.parse(rows[0].command));
    } catch (error) {
      outcome = ['conflict', 'expired'].includes(error.commandCode) ? error.commandCode : 'rejected';
      changes = [];
    }
    const completedAt = new Date().toISOString();
    rows.forEach(function (row) { changes.push(cpWriteCells_(sheet, row.sheetRow, 4, [outcome, completedAt])); });
    // Prayer, moderation status and durable receipts succeed or fail together.
    // All supported script/menu writers share this lock. Direct Sheet/API edits
    // do not honor it; administrators must not edit cells concurrently with saves.
    Sheets.Spreadsheets.batchUpdate({ requests: changes }, PropertiesService.getScriptProperties().getProperty('CP_SHEET_ID'));
    return cpResult_({ outcome: outcome });
  });
}
