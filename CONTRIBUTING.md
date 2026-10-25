# Contributing

Thanks for taking the time to improve this project.

## Development setup

1. Windows with WeChat DevTools installed.
2. Node.js >= 20.
3. Enable **Settings → Security Settings → Service Port (CLI/HTTP)** in
   WeChat DevTools.
4. Install dependencies:

   ```bash
   npm install
   ```

5. Copy `.env.example` to `.env` if you need local overrides. The server reads
   environment variables directly; it does not load `.env` automatically.

## Code style

- ES modules, 2 spaces, single quotes, semicolons.
- Run `npm run format` before committing.
- Run `npm run check` to validate syntax.
- Keep comments focused on why a workaround exists (CLI cwd, stale `.ide`,
  automation reuse), not on restating the code.

## Tests

The integration tests require a running WeChat DevTools installation:

```bash
npm run test:e2e
```

CLI tests need a project with a real AppID:

```powershell
$env:WECHAT_DEVTOOLS_TEST_USER_PROJECT="C:/path/to/your-miniprogram"
npm run test:cli
```

`test:cli` quits and restarts the IDE. Save your work before running it.

## Pull requests

- Keep changes focused and describe the user-visible behavior.
- Add or update tests when changing tool behavior.
- Update `CHANGELOG.md` under an “Unreleased” or new version heading.
- Mention any WeChat DevTools version you tested against.
