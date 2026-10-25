# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-26

### Fixed

- CI now runs on `windows-latest`. The package declares `os: ["win32"]`, so
  `npm ci` on Ubuntu failed with `EBADPLATFORM` for the `v1.0.0` workflow.
  The `v1.0.0` tag is left in place; use `v1.0.1` as the first verified
  release.

## [1.0.0] - 2026-10-25

First public release.

### Added

- MCP server with 23 tools for WeChat DevTools on Windows.
- Official CLI integration: open, close, quit, login, login status, preview,
  build npm, and gated upload.
- Official miniprogram-automator integration: navigation, page stack, element
  query and actions, page data, evaluate, wx methods, native dialogs, and
  screenshots.
- Automatic IDE startup before CLI operations, with stale `.ide` recovery and
  backup files.
- Automation session reuse by default; explicit `restart` mode.
- Page validation against `app.json` and `tabBar` for navigation.
- Evaluation modes for expressions, statement blocks, and raw functions with
  `$args` support.
- Regression suites: 52 automation checks and 13 CLI/recovery checks.
- Test mini program fixture using `touristappid`.

### Fixed

- CLI must run with the DevTools installation directory as process cwd.
- `wdt_quit` now waits for the actual IDE port to close, up to 40 seconds.
- CLI commands exiting with code 0 while printing `[error]` are reported as
  failures with a readable hint.
- `callMethod` falls back to `evaluate` when the automation SDK rejects it.
- `slideTo` dispatches a `change` event so page data stays in sync.
- Opaque `Uncaught [object Object]` navigation errors are replaced with
  actionable messages.
- Upload is disabled unless explicitly enabled and confirmed.

### Security

- Upload is off by default.
- The server uses stdio only and does not listen on a network port.
- `evaluate` and `wx` method calls are documented as local arbitrary execution.
