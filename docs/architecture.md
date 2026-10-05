# Church-owned group management

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
a provider adapter with fixed Google URLs and validated template data.
The UI cancels requests and guards late callbacks when signing out or changing
groups. Errors do not include Google response bodies or prayer content.

Google permission is file-level and read/write. Existing Editors are fully trusted by the spreadsheet itself; the
UI's Editor check is a product rule, not an additional server security boundary.
Revocation is detected on a subsequent request, not pushed to idle tabs.

## Mutation authority and concurrency

The public Apps Script executes as the church owner; a public link or browser-sent
email is NOT administrator authentication. Instead:

1. A Google-authorized Editor appends a versioned command to the private sheet's
   ConsoleCommands tab with Sheets values.append using RAW input and a random UUID.
2. The browser asks the church endpoint to process that operation ID. It sends no
   command payload and no Google bearer token. The public submission credential
   scopes this request to the group; it does not confer administrator privileges.
3. The script acquires the same lock as spreadsheet-menu operations and public
   submissions. It reads the private command and checks age, target UUID, expected
   row hash, fields, and original consent. A stale edit returns a conflict.
4. One Sheets advanced-service batch applies the change and terminal receipt.
   Cells use literal stringValue, not formulas. Retrying the same operation ID
   returns its receipt without duplicating a prayer or approving twice.
5. The console re-reads the sheet. A lost response leaves an uncertain save, not
   a false claim that nothing happened. Retry that editor's same change or inspect
   Change history after reloading; do not create a fresh ID just because it timed out.

ConsoleSettings binds the selected sheet to its group/deployment and public
submission credential. The service's sheet ID is checked before enqueueing a
command or showing embed HTML. Old sheets remain read-only until their owner
upgrades the script/manifest, updates the existing deployment version, and runs
Enable administrator console. No additional console OAuth scopes are required.

A public caller can wake an already authorized command if it knows its UUID, but
cannot provide a command, enumerate the queue, or retrieve prayer/contact data
through console-processing. The sheet's Google ACL is the mutation authority.
Never add privileged payloads authenticated only by public/member credentials.
Opaque outcomes and group identity are not confidential. An already submitted
command may still finish after Editor revocation or browser sign-out.

**Lock boundary:** supported script writers share a lock and flush buffered menu
writes before releasing it. Direct cell edits, sorting/deletion, other API clients,
and separate script projects do not honor this lock. Coordinate manual maintenance.
Sheets batch atomicity is not compare-and-swap with arbitrary collaborators.

## Consent, submissions, and retention

The journal's existing hosted submission form is embedded with a CPG1.s link.
Never put a CPG1.m member invitation into public HTML. Visitors submit directly
to the church's service/private Inbox without admin login. Consent is required;
the default is group-only. Approval copies only prayer fields, not contact, and
server checks prevent widening original consent. Owners can still edit underlying
cells. Administrators must not paste private contact details into published wording.

Pending commands expire after 24 hours. Terminal outcomes are applied, conflict,
rejected, and expired. ConsoleCommands retains payloads/receipts, including prayer
wording; it is operational history, not a verified-author or tamper-proof audit log.
There is no background worker; pending work needs a console retry/check.

The pilot accepts 2,000 data rows per records/history tab and 1,000 published
prayers within the feed size limit. Privately archive completed history rows only
after 24 hours, preserving headers. Do not delete pending commands or edit payloads.
These are provider-adapter limits, not a cap on administrator accounts. Church
accounts retain responsibility for quotas and public-endpoint abuse. No paid
central service is added. Alternative providers and finer roles remain future work.

## Release gates

Unit tests cover endpoint isolation, retries, consent, malformed responses, and
permissions. The journal repository tests the actual script in a VM with Sheets
and lock doubles, including stale edits, atomic failure, and lost responses.
Browser tests use fake accounts and simulated Google responses, never live prayers.

Follow `public/setup.html#management-upgrade` and complete live checks for Google
authorization, service redirects, two Editors, concurrent submissions, interrupted
saves, revocation, and the church's iframe policy. Tests do not prove live OAuth or
Workspace compatibility. Publishing code does not update church deployments.
