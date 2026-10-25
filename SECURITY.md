# Security Policy

## Supported versions

Security fixes are applied to the latest release.

## Reporting a vulnerability

Please open a private security advisory on GitHub or contact the maintainer
directly. Do not open a public issue for an unpatched vulnerability.

## Local execution surface

This project is a local MCP server. It can:

- start and quit WeChat DevTools;
- open projects and generate preview QR codes;
- execute JavaScript in the mini program app context (`wdt_evaluate`);
- call `wx` APIs (`wdt_wx_method`);
- take simulator screenshots.

Treat it like a local automation tool with the same privileges as your user
account. Do not expose it to untrusted prompts or remote clients. The server
uses stdio only and does not listen on a network port.

## Uploads

`wdt_upload` is disabled by default. It requires both
`WECHAT_DEVTOOLS_MCP_ALLOW_UPLOAD=1` and `confirm=true`. Uploading creates a
version on the WeChat platform and cannot be undone by this project.

## Credentials

The server does not collect or store WeChat credentials, CLI tokens, or
cookies. If a CLI token is required, pass it through the
`WECHAT_DEVTOOLS_CLI_TOKEN` environment variable on your machine.

## Known upstream advisories

`miniprogram-automator@0.13.0` (the latest official release) still pulls in
`jimp@0.6.8` and `phin@2.9.3`. `npm audit --omit=dev` reports five moderate
advisories from that chain. The project applies npm overrides for the
reachable critical/high issues (`minimist`, `mkdirp`, `jpeg-js`) but does not
force-upgrade or downgrade the upstream SDK, because that would either break
its API or reintroduce the same transitive tree.

The affected image/HTTP code is not used by this MCP server’s tool surface.
Still, treat the process as local-only and do not feed it untrusted files or
URLs. Dependabot is configured to surface upstream updates.
