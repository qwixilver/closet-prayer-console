# Closet Prayer Administrator Console

A separate, static console for church-owned Closet Prayer groups. The prayer
journal at https://closetprayer.com remains independent and local-first.

## Status: group-management pilot

Implemented: Google account connection, per-file Google Picker selection, Editor
permission checks, submissions/prayers, search, refresh, session expiry,
responsive cards, and selectable, memory-only connection diagnostics containing
fixed step names and timestamps. A top-layer recovery prompt offers to close a
stalled Picker after 45 seconds without signing out or losing diagnostics. Frame
diagnostics observe load/message arrival only, never message contents or file
authorization. No administrator-count cap and no central prayer
database.

Management adds draft creation, editing, publishing/withdrawal, answered status,
submission approval/decline, retryable change history, and a verified public form
link/iframe. Each church must upgrade its bound script and enable management;
older sheets remain read-only. Original group-only consent cannot be widened.

**Not implemented:** group creation inside the console, roles beyond spreadsheet
permissions, automatic account reconnection, or other storage providers. Browser
and API mocks do not prove live write/redirect/Workspace compatibility; complete
the live checklist in the setup guide before using real prayer data.

## Google project and hosting setup

The complete, readable new-project guide is [public/setup.html](public/setup.html),
served as `/setup.html` on the console website. It covers OAuth, restricted Picker
keys, test users, Pages, the manual Cloudflare DNS record, and live verification.
The console operator configures one Google project; each church retains its own
spreadsheet and Apps Script deployment. A self-hosted fork uses its own project.

Already connected? Start at [Enable management](public/setup.html#management-upgrade),
not the OAuth setup. Update Code.gs and its manifest in the existing church script,
enable the Sheets advanced service, update the existing web deployment's version,
and run **Closet Prayer > Enable administrator console** in the sheet with its
public submission link. Templates and the church guide live in the
[journal repository](https://github.com/qwixilver/P.U.S.H.-Prayer_Journal/tree/main/group-service/google-apps-script)
and are distributed at https://closetprayer.com/guides/groups/.

Three public browser settings are needed, following `.env.example`:

```
VITE_GOOGLE_CLIENT_ID=
VITE_GOOGLE_API_KEY=
VITE_GOOGLE_PROJECT_NUMBER=
```

Use `.env.local` locally or GitHub Actions repository **variables** when deploying.
The browser key must have website and API restrictions. No client secret is used.
Without valid configuration, the site shows setup instructions and disables login.

Brave cookie blocking can stall Google Picker before any selection callback.
Live testing confirmed that a site-only `Allow all cookies` exception resolved
this with Shields otherwise enabled. The connection panel and recovery dialog
link to [the cookie compatibility guide](public/setup.html#brave-cookies), which
explains the third-party cookie tradeoff without recommending global exceptions.
Diagnostics do not automatically identify cookie blocking or inspect settings.

## Development

Use Node 22.12+ (Node 22 LTS is used in CI):

```sh
npm ci
npm test
npm run dev
npm run build
```

Open http://localhost:5174, not a raw LAN/Tailscale address, for Google OAuth.
`npm run preview` serves a built site at http://localhost:4175. Use the configured
HTTPS domain for mobile Google testing.

The optional browser test uses Playwright with Edge. After a normal unconfigured
`npm run build`, set `CP_PLAYWRIGHT_PATH` to an existing Playwright module directory
and run `node tests/browser.mjs`. The test creates its own mock-configured build,
starts and stops temporary servers on ports 4175/4176, and intercepts all Google
responses. Never use real credentials or church data in fixtures.
Set `CP_LIVE_GOOGLE_SDK=1` to also test recovery against Google's real public
Picker library. Only SDK scripts are live; account sign-in, frame contents, and
file API responses remain intercepted. This does not validate a real selection.

## Security boundaries

- Google enforces file access; a group invitation is not an administrator login.
- `drive.file` allows access to selected/previously authorized files, not all Drive.
  The console appends commands to the selected private sheet using this permission.
- Tokens, account details, and downloaded prayers stay in page memory. No personal
  journal database, browser persistence, analytics, or prayer-content logs.
- Google tokens never go to user-provided Apps Script URLs. No arbitrary provider
  endpoint can receive authenticated Google requests.
- Console reads Requests/Inbox plus ConsoleSettings/ConsoleCommands. File-level
  authorization is broader than those columns; Editors are trusted administrators.
- The church script serializes console/menu/submission changes, checks row versions,
  and atomically writes console changes with their receipts. A public submission
  token can wake an existing private command, not supply a mutation or read prayers.
- Direct cell edits and other API clients bypass the script lock. Do not sort,
  delete, or manually edit rows during saves. See [architecture](docs/architecture.md).
- Commands contain prayer wording and remain in the private sheet. History is not
  a tamper-proof audit log. Disconnecting cannot undo an already queued change.

## Deploy

The `Deploy console` workflow tests and builds `main`, then publishes to GitHub
Pages. Enable Pages with GitHub Actions as the source. Set the custom domain in
Pages **before** adding its DNS record. See the setup guide for the exact record.

Do not commit secrets or prayer data. This repository is public.

## License

Copyright (C) 2026 Closet Prayer Console contributors.

This project's original code and documentation are licensed under the
[GNU General Public License, version 3 only](LICENSE) (`GPL-3.0-only`). You may
redistribute and modify them under that license. They are provided without any
warranty, including implied warranties of merchantability or fitness for a
particular purpose. See the full license for its terms. Third-party dependencies
retain their own licenses.
