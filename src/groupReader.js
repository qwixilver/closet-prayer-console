// SPDX-License-Identifier: GPL-3.0-only
export const REQUEST_HEADERS = ['id', 'publication', 'visibility', 'consent', 'title', 'description', 'requestor', 'requestedAt', 'status'];
export const INBOX_HEADERS = ['id', 'receivedAt', 'title', 'description', 'requestor', 'contact', 'allowedSharing', 'reviewStatus'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_ROWS = 2000;
const MAX_RESPONSE = 25 * 1024 * 1024;

export class GoogleAccessError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function getJson(url, session, { signal, fetchImpl = fetch } = {}) {
  if (Date.now() >= session.expiresAt) throw new GoogleAccessError('Your Google session expired. Connect again.', 401);
  // The caller constructs every URL; tokens never go to a church-provided endpoint.
  const response = await fetchImpl(url, {
    method: 'GET', headers: { Authorization: `Bearer ${session.token}` },
    credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const messages = {
      401: 'Your Google session expired or was revoked. Connect again.',
      403: 'Google denied access. Check file sharing, the enabled APIs, and your organization policies.',
      404: 'This file is unavailable. Select it again in Google Picker or ask its owner for access.',
      429: 'Google is receiving too many requests. Wait a moment before trying again.',
    };
    throw new GoogleAccessError(messages[response.status] || 'Google could not complete the request. Please try again later.', response.status);
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE) throw new Error('This group is too large for the connection preview. Use the spreadsheet to archive older rows.');
  try { return JSON.parse(body); } catch { throw new Error('Google returned an unreadable response. Please try again.'); }
}

export async function readProfile(session, options) {
  const profile = await getJson('https://openidconnect.googleapis.com/v1/userinfo', session, options);
  if (!profile || typeof profile.sub !== 'string' || typeof profile.email !== 'string' || profile.email_verified !== true) {
    throw new Error('A verified Google account email is required to connect.');
  }
  return { name: typeof profile.name === 'string' ? profile.name : profile.email, email: profile.email };
}

function dateText(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label}: invalid date.`);
  const date = typeof value === 'number' ? new Date((value - 25569) * 86400000) : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error(`${label}: invalid date.`);
  return date.toISOString();
}

export function parseRows(values, type) {
  const headers = type === 'Requests' ? REQUEST_HEADERS : INBOX_HEADERS;
  if (!Array.isArray(values) || JSON.stringify(values[0]) !== JSON.stringify(headers)) {
    throw new Error(`${type}: the column headers do not match the Closet Prayer template. No changes were made.`);
  }
  if (values.length > MAX_ROWS + 1) throw new Error(`${type}: archive older rows in the spreadsheet before connecting (maximum ${MAX_ROWS}).`);
  const ids = new Set();
  return values.slice(1).flatMap((cells, index) => {
    const label = `${type} row ${index + 2}`;
    if (!Array.isArray(cells)) throw new Error(`${label}: invalid row.`);
    if (cells.every(cell => cell === '' || cell == null)) return [];
    const row = Object.fromEntries(headers.map((key, col) => [key, cells[col] ?? '']));
    if (typeof row.id !== 'string' || !UUID.test(row.id) || ids.has(row.id.toLowerCase())) {
      throw new Error(`${label}: missing, invalid, or duplicate prayer ID. Ask the sheet owner to repair this row.`);
    }
    ids.add(row.id.toLowerCase());
    for (const [field, limit] of [['title', 200], ['description', 10000], ['requestor', 120], ...(type === 'Inbox' ? [['contact', 200]] : [])]) {
      if (typeof row[field] !== 'string' || row[field].length > limit || (field === 'title' && !row[field].trim())) {
        throw new Error(`${label}: invalid ${field}. Check it in the spreadsheet.`);
      }
    }
    const enums = type === 'Requests'
      ? { publication: ['draft', 'published', 'withdrawn'], visibility: ['group-only', 'shareable'],
          consent: ['group-only', 'shareable'], status: ['requested', 'answered'] }
      : { allowedSharing: ['group-only', 'shareable'], reviewStatus: ['pending', 'approved', 'declined'] };
    for (const [field, allowed] of Object.entries(enums)) {
      if (!allowed.includes(row[field])) throw new Error(`${label}: invalid ${field}. Check it in the spreadsheet.`);
    }
    row.date = dateText(row[type === 'Requests' ? 'requestedAt' : 'receivedAt'], label);
    row.sharing = type === 'Inbox' ? row.allowedSharing
      : row.visibility === 'shareable' && row.consent === 'shareable' ? 'shareable' : 'group-only';
    return [row];
  });
}

export async function readGroup(fileId, session, options) {
  if (!/^[\w-]{16,200}$/.test(fileId || '')) throw new Error('Choose a valid spreadsheet with Google Picker.');
  const driveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  driveUrl.searchParams.set('fields', 'id,name,mimeType,trashed,capabilities(canEdit)');
  driveUrl.searchParams.set('supportsAllDrives', 'true');
  const file = await getJson(driveUrl.href, session, options);
  if (file.trashed || file.mimeType !== 'application/vnd.google-apps.spreadsheet') throw new Error('Select an existing Google spreadsheet, not an uploaded workbook or a deleted file.');
  if (file.capabilities?.canEdit !== true) throw new GoogleAccessError('Administrator access requires Editor permission on this spreadsheet. Ask the church owner to share it with your Google account.', 403);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}`;
  const metadataUrl = new URL(base);
  metadataUrl.searchParams.set('fields', 'sheets(properties(title,gridProperties(rowCount,columnCount)))');
  const metadata = await getJson(metadataUrl.href, session, options);
  const ranges = ['Requests', 'Inbox'].map((title, i) => {
    const sheet = metadata.sheets?.find(item => item.properties?.title === title)?.properties;
    const width = i === 0 ? REQUEST_HEADERS.length : INBOX_HEADERS.length;
    if (!sheet || !Number.isInteger(sheet.gridProperties?.rowCount) || sheet.gridProperties.rowCount < 1 ||
        !Number.isInteger(sheet.gridProperties.columnCount) || sheet.gridProperties.columnCount < width) {
      throw new Error(`This is not a configured Closet Prayer group. The ${title} tab is missing or incomplete. See the group setup guide.`);
    }
    // Read to the grid boundary: stopping at the limit could hide later nonempty
    // rows after a gap. Sheets omits trailing empty rows; parseRows rejects overflow.
    return `'${title}'!A1:${i === 0 ? 'I' : 'H'}${sheet.gridProperties.rowCount}`;
  });
  const valuesUrl = new URL(`${base}/values:batchGet`);
  ranges.forEach(range => valuesUrl.searchParams.append('ranges', range));
  valuesUrl.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
  valuesUrl.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
  const data = await getJson(valuesUrl.href, session, options);
  if (data.valueRanges?.length !== 2) throw new Error('Google did not return both group tabs. Please try again.');
  return { id: fileId, name: typeof file.name === 'string' ? file.name : 'Church spreadsheet',
    requests: parseRows(data.valueRanges[0].values, 'Requests'),
    inbox: parseRows(data.valueRanges[1].values, 'Inbox'), loadedAt: Date.now() };
}
