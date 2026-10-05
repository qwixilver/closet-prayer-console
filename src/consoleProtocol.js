// SPDX-License-Identifier: GPL-3.0-only
export const COMMAND_HEADERS = ['id', 'createdAt', 'command', 'outcome', 'completedAt'];
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseConsoleSettings(values) {
  if (!Array.isArray(values) || JSON.stringify(values[0]) !== '["key","value"]' || values.length > 32) throw new Error('Console settings are invalid. Run Enable administrator console in the spreadsheet.');
  const settings = {};
  for (const row of values.slice(1)) {
    if (!row?.[0]) continue;
    if (Object.hasOwn(settings, row[0]) || typeof row[1] !== 'string') throw new Error('Duplicate or invalid console settings.');
    Object.defineProperty(settings, row[0], { value: row[1], enumerable: true });
  }
  if (settings.protocol !== 'cp-console' || settings.version !== '1' || !UUID.test(settings.groupId || '') ||
      !/^[a-zA-Z0-9_-]{43}$/.test(settings.submissionToken || '')) throw new Error('Upgrade and enable the administrator console in the spreadsheet.');
  let url;
  try { url = new URL(settings.endpoint); } catch { throw new Error('The console service address is invalid.'); }
  if (url.origin !== 'https://script.google.com' || url.username || url.password || url.search || url.hash ||
      !/^\/macros\/s\/[a-zA-Z0-9_-]{16,160}\/exec$/.test(url.pathname)) throw new Error('Use the deployed Google Apps Script service address.');
  return { groupId: settings.groupId.toLowerCase(), endpoint: url.href, token: settings.submissionToken };
}

export function submissionLinks(settings) {
  const deployment = new URL(settings.endpoint).pathname.split('/')[3];
  const link = `https://closetprayer.com/#group=CPG1.s.${deployment}.${settings.groupId}.${settings.token}`;
  return { link, embed: `<iframe src="${link}" title="Submit a prayer request" width="100%" height="950" style="border:0" referrerpolicy="no-referrer" loading="lazy"></iframe>` };
}

export function parseCommands(values) {
  if (!Array.isArray(values) || JSON.stringify(values[0]) !== JSON.stringify(COMMAND_HEADERS) || values.length > 2001) throw new Error('Console command history needs maintenance in the spreadsheet.');
  const commands = new Map();
  for (const cells of values.slice(1)) {
    if (cells.every(cell => cell === '' || cell == null)) continue;
    const [id, createdAt, payload, outcome, completedAt = ''] = cells;
    if (!UUID.test(id || '') || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) ||
        typeof payload !== 'string' || payload.length > 16000 || !['pending', 'applied', 'conflict', 'rejected', 'expired'].includes(outcome)) throw new Error('Invalid console command history. Ask the sheet owner to repair it.');
    let command;
    try { command = JSON.parse(payload); } catch { throw new Error('Invalid console command history.'); }
    if (!command || command.version !== 1 || !UUID.test(command.id || '') || !['create', 'update', 'approve', 'decline'].includes(command.type)) throw new Error('Unsupported console command history.');
    const previous = commands.get(id);
    if (previous && JSON.stringify(previous.command) !== payload) throw new Error('Conflicting command IDs in the spreadsheet.');
    if (!previous || previous.outcome === 'pending') commands.set(id, { id, createdAt, command, outcome, completedAt });
  }
  return [...commands.values()];
}

export async function callConsoleService(settings, action, options = {}) {
  if (!['console-info', 'console-process'].includes(action)) throw new Error('Unsupported console operation.');
  parseConsoleSettings([['key', 'value'], ['protocol', 'cp-console'], ['version', '1'], ['groupId', settings.groupId], ['endpoint', settings.endpoint], ['submissionToken', settings.token]]);
  const { signal, fetchImpl = fetch, requestId } = options;
  const response = await fetchImpl(settings.endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store',
    referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ protocol: 'cp-group', version: 1, groupId: settings.groupId, token: settings.token, action, ...(requestId ? { requestId } : {}) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error('The church service could not respond. Check the deployment and try again.');
  const text = await response.text();
  if (text.length > 20000) throw new Error('Unexpected church service response.');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('Update the script deployment with access set to Anyone.'); }
  if (result?.protocol !== 'cp-group' || result.version !== 1 || !result.ok || result.group?.id !== settings.groupId) throw new Error('The church service could not verify this console connection. Upgrade the script and check the public submission link.');
  return result;
}
