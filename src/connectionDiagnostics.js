// SPDX-License-Identifier: GPL-3.0-only
export const CONNECTION_STEPS = Object.freeze({
  'picker-opening': 'Preparing Google Picker',
  'picker-open': 'Picker opened; waiting for confirmation',
  'picker-loaded': 'Google reported that the picker loaded',
  'picker-other-event': 'Google sent a non-selection picker event',
  'picker-waiting': 'Still waiting for Google to confirm or cancel the selection',
  'picker-selection-received': 'Google returned a confirmed spreadsheet selection',
  'picker-invalid-selection': 'Google returned an invalid spreadsheet identifier',
  'picker-cancelled': 'Google reported that the picker was cancelled',
  'picker-interrupted': 'The console interrupted the picker',
  'picker-error': 'Google reported a picker error',
  'picker-open-error': 'The picker could not be opened',
  'picker-response-error': 'The console could not process the picker response',
  'picker-cleanup-warning': 'The picker reported an error while closing',
  'group-reading': 'Selection accepted; checking access and reading the group',
  'group-loaded': 'Group loaded successfully',
  'connection-failed': 'The connection attempt ended with an error',
});

export function appendConnectionStep(events, code, at = Date.now()) {
  if (!Object.hasOwn(CONNECTION_STEPS, code) || !Number.isFinite(at)) return events;
  return [...events.slice(-23), { code, at }];
}

export function formatConnectionSteps(events) {
  const safe = events.filter(event => Object.hasOwn(CONNECTION_STEPS, event.code) && Number.isFinite(event.at));
  return ['Closet Prayer connection diagnostics v1 (step names only)',
    ...safe.map(event => `${new Date(event.at).toISOString()} | ${event.code}`)].join('\n');
}
