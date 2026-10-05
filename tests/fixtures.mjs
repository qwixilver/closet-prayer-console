export const fileId = 'test_spreadsheet_1234567890';
export const requestHeaders = ['id', 'publication', 'visibility', 'consent', 'title', 'description', 'requestor', 'requestedAt', 'status'];
export const inboxHeaders = ['id', 'receivedAt', 'title', 'description', 'requestor', 'contact', 'allowedSharing', 'reviewStatus'];
export const requestRow = ['a1111111-1111-4111-8111-111111111111', 'published', 'shareable', 'group-only',
  'A sample prayer for testing', 'A long test description that should take the full width of the card on a phone. This is fictional test data.',
  'Example Person', '2026-10-01T12:00:00Z', 'requested'];
export const inboxRow = ['b2222222-2222-4222-8222-222222222222', '2026-10-02T12:00:00Z',
  'A fictional inbox submission', 'Please use this sample only for automated testing.', 'Test Submitter', 'private-test@example.invalid', 'group-only', 'pending'];
export function responses() {
  return [
    { id: fileId, name: 'Example Church Test Group', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, capabilities: { canEdit: true } },
    { sheets: ['Requests', 'Inbox'].map(title => ({ properties: { title, gridProperties: { rowCount: 1000, columnCount: 26 } } })) },
    { valueRanges: [{ values: [requestHeaders, requestRow] }, { values: [inboxHeaders, inboxRow] }] },
  ];
}

export const groupId = '11111111-2222-4333-8444-555555555555';
export const endpoint = 'https://script.google.com/macros/s/test_deployment_1234567890/exec';
export const settingsRows = [['key', 'value'], ['protocol', 'cp-console'], ['version', '1'], ['groupId', groupId], ['endpoint', endpoint], ['submissionToken', 'S'.repeat(43)]];
export const commandHeaders = ['id', 'createdAt', 'command', 'outcome', 'completedAt'];
export function managedResponses(commands = []) {
  const data = responses();
  data[1].sheets.push(...['ConsoleSettings', 'ConsoleCommands'].map(title => ({ properties: { title, gridProperties: { rowCount: 1000, columnCount: 5 } } })));
  data[2].valueRanges.push({ values: structuredClone(settingsRows) }, { values: [commandHeaders, ...commands] });
  return data;
}
