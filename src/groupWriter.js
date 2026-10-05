// SPDX-License-Identifier: GPL-3.0-only
import { googleJson, readGroup, REQUEST_HEADERS, INBOX_HEADERS } from './groupReader.js';
import { callConsoleService, UUID } from './consoleProtocol.js';

export async function rowRevision(row, inbox = false) {
  const values = (inbox ? INBOX_HEADERS : REQUEST_HEADERS).map(key => key === 'requestedAt' || key === 'receivedAt' ? row.date : row[key]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function verifyManagement(group, options) {
  if (!group.management) throw new Error('Upgrade the church script and run Enable administrator console first.');
  const result = await callConsoleService(group.management, 'console-info', options);
  if (result.consoleVersion !== 1 || result.sheetId !== group.id) throw new Error('The submission service does not belong to the selected spreadsheet. Ask the owner to correct ConsoleSettings.');
}

export const OUTCOME_MESSAGES = {
  conflict: 'This record changed since you opened it. Refresh, review the latest version, and try again. Your change was not applied.',
  rejected: 'The service rejected this change. Check consent, required fields, and group/history limits. Your change was not applied.',
  expired: 'This pending change expired after 24 hours. Refresh and review the record before creating a new change.',
};

export async function processPending(group, id, session, options) {
  if (!UUID.test(id || '')) throw new Error('Invalid change identifier.');
  // Recheck current Editor access before asking the service to finish a command.
  const current = await readGroup(group.id, session, options);
  await verifyManagement(current, options);
  const result = await callConsoleService(current.management, 'console-process', { ...options, requestId: id });
  if (result.outcome !== 'applied') throw new Error(OUTCOME_MESSAGES[result.outcome] || 'The change is not confirmed. Refresh the change history before trying again.');
  return readGroup(group.id, session, options);
}

export async function saveCommand(group, operation, session, options) {
  if (!UUID.test(operation.id || '') || operation.command?.version !== 1 || !UUID.test(operation.command.id || '')) throw new Error('Invalid change.');
  if (JSON.stringify(operation.command).length > 16000) throw new Error('This change is too large. Shorten the wording before saving.');
  const current = await readGroup(group.id, session, options);
  await verifyManagement(current, options);
  const previous = current.commands.find(command => command.id === operation.id);
  if (previous && JSON.stringify(previous.command) !== JSON.stringify(operation.command)) throw new Error('This change identifier was already used for another operation.');
  if (!previous) {
    if (current.commands.length >= 2000) throw new Error('Archive completed command history in the spreadsheet before saving more changes.');
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${current.id}/values/ConsoleCommands!A:E:append`);
    url.searchParams.set('valueInputOption', 'RAW');
    url.searchParams.set('insertDataOption', 'INSERT_ROWS');
    await googleJson(url.href, session, options, { majorDimension: 'ROWS', values: [[operation.id, operation.createdAt, JSON.stringify(operation.command), 'pending', '']] });
  }
  const result = await callConsoleService(current.management, 'console-process', { ...options, requestId: operation.id });
  if (result.outcome !== 'applied') throw new Error(OUTCOME_MESSAGES[result.outcome] || 'The save is not confirmed. Refresh the change history before creating another change.');
  return readGroup(group.id, session, options);
}
