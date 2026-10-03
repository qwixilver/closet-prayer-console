# Connection preview and next milestone

## Implemented boundary

This static React app talks directly to Google's identity, Picker, Drive, and
Sheets APIs. Google identity is obtained from the authenticated userinfo endpoint,
not from trusting a browser-decoded token. `drive.file` access is granted through
Picker; Drive's `capabilities.canEdit` is checked before any private group rows
are read. The backend checks Google's actual file ACL on every request.

There is no persistent console account, backend proxy, or token refresh service.
There is no automatic synchronization or offline copy in this console. The
personal journal and the member group synchronization protocol are unchanged.

`src/google.js` handles the SDK/picker and token lifetime. `src/groupReader.js` is
a read-only provider adapter with fixed Google URLs and validated template data.
The UI cancels requests and guards late callbacks when signing out or changing
groups. Errors do not include Google response bodies or prayer content.

Google permission is file-level and read/write even though the current adapter
only reads. Existing Editors are fully trusted by the spreadsheet itself; the
UI's Editor check is a product rule, not an additional server security boundary.
Revocation is detected on a subsequent request, not pushed to idle tabs.

## Before enabling management operations

1. Decide the church-owned mutation authority. The existing public Apps Script
   deployment executes as the owner and does not authenticate admin Google users.
   Do not add privileged operations guarded only by a member token or email sent
   by the browser. Do not forward Google bearer tokens to arbitrary script URLs.
2. Make approval/retry idempotent using permanent submission/request IDs. Serialize
   or conflict-check competing administrators and existing spreadsheet menu
   operations. A client-side read followed by write is not compare-and-swap;
   Sheets batch atomicity alone does not prevent lost updates between clients.
3. Preserve maximum submitter consent. A group-only submission must not become
   shareable just because an administrator changes visibility. Administrator-only
   contacts must never enter the member feed or an exported prayer.
4. Safely handle formulas, row insertion/deletion/reordering, ambiguous network
   failures, revoked access, schema upgrades, and partial operations. Test two
   administrators and a simultaneous public submission against a real deployment.
5. Add activity history and role design deliberately. Do not imply a spreadsheet
   Editor has a restricted role that the underlying storage does not enforce.

The initial 2,000-row read limit matches the existing Apps Script template's
archive requirement. It is not an account-count or provider-wide design limit.
Alternative adapters can follow later without centralizing church prayer data.

## Release gates

Google project values, consent/branding review, DNS/HTTPS,
and the real-account checklist in `public/setup.html` remain operator steps.
Unit and mocked-browser tests verify local behavior, not Google's live consent,
Picker referrer restrictions, mobile popup behavior, or Workspace policy choices.
