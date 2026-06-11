# Vendored pi-mcp-extension

This directory vendors `pi-mcp-extension` for local Pi use.

- Upstream package: `pi-mcp-extension`
- Vendored version: `1.5.0`
- npm tarball integrity at vendoring time: `sha512-tfsgi8qSr3UUKMp4vS9/FwKv+Pn2U4T/rTlAwrZkEIvz616mFrU/Ryp3b69ZDfFdkQVVXriaQmZUj4vlZDV2Uw==`
- Original repository: `https://github.com/irahardianto/pi-mcp-extension`

Local modifications:

- `package.json` is rewritten for local vendoring with exact runtime dependency versions.
- The package is loaded directly from `~/.pi/agent/extensions/pi-mcp-extension` instead of through `pi install`.

Pi discovers this extension via the `pi.extensions` manifest in `package.json`.

MCP server configuration lives in `~/.pi/agent/mcp.json`.
