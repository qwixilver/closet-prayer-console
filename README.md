# Closet Prayer Administrator Console

A separate, static console for church-owned Closet Prayer groups. The prayer
journal at https://closetprayer.com remains independent and local-first.

## Status: connection preview

Implemented: Google account connection, per-file Google Picker selection, Editor
permission checks, read-only submissions/prayers, search, refresh, session expiry,
and responsive cards. No administrator-count cap and no central prayer database.

**Not implemented:** console approval/edit/withdraw operations, group creation,
roles beyond spreadsheet permissions, automatic account reconnection, or other
storage providers. Continue using the spreadsheet's Closet Prayer menu to manage
requests. Browser/API mocks do not prove real OAuth or Workspace compatibility;
complete the live checklist in the setup guide before using real prayer data.

## Google project and hosting setup

The complete, readable new-project guide is [public/setup.html](public/setup.html),
served as `/setup.html` on the console website. It covers OAuth, restricted Picker
keys, test users, Pages, the manual Cloudflare DNS record, and live verification.
The console operator configures one Google project; each church retains its own
spreadsheet and Apps Script deployment. A self-hosted fork uses its own project.

Three public browser settings are needed, following `.env.example`:

```
VITE_GOOGLE_CLIENT_ID=
VITE_GOOGLE_API_KEY=
VITE_GOOGLE_PROJECT_NUMBER=
```

Use `.env.local` locally or GitHub Actions repository **variables** when deploying.
The browser key must have website and API restrictions. No client secret is used.
Without valid configuration, the site shows setup instructions and disables login.

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

## Security boundaries

- Google enforces file access; a group invitation is not an administrator login.
- `drive.file` allows access to selected/previously authorized files, not all Drive.
  It includes write access, but this release only issues GET requests.
- Tokens, account details, and downloaded prayers stay in page memory. No personal
  journal database, browser persistence, analytics, or prayer-content logs.
- Google tokens never go to user-provided Apps Script URLs. No arbitrary provider
  endpoint can receive authenticated Google requests.
- Console reads only template Requests/Inbox columns. File-level authorization is
  broader than those columns; spreadsheet Editors are trusted administrators.
- Read-only controls are intentional. See [the next milestone](docs/architecture.md)
  for required authorization, privacy, and concurrency work before enabling writes.

## Deploy

The `Deploy console` workflow tests and builds `main`, then publishes to GitHub
Pages. Enable Pages with GitHub Actions as the source. Set the custom domain in
Pages **before** adding its DNS record. See the setup guide for the exact record.

Do not commit secrets or prayer data. This repository is public. A formal license
has not yet been selected; public source availability alone does not grant an
open-source license.
