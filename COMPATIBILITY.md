# Client compatibility receipt

Checked on 2026-10-03. MCP registration, transport access, app consent, and a model-driven task are separate checks.

| Surface                        | Verified evidence                                                                                                                  | Limit                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Canonical Windows MCP launcher | Real MCP SDK initialization, four tools, official Sky import, and Calculator inventory. Client close exits 0.                      | The read-only probe does not prove input.                                                               |
| Canonical browser MCP launcher | Real MCP SDK initialization, four tools, and the required first `await cua.getState()` call. Client close exits 0.                 | Browser input through Cline is unverified.                                                              |
| Installed Cline CLI 3.0.65     | Its `@cline/core` 0.0.86 stdio client sends empty capabilities and handles response IDs without an elicitation request handler.    | Windows consent/input is unsupported in this default client.                                            |
| Cline Desktop source           | The Desktop sidecar uses the shared ClineCore hub. Its approval UI handles tool approval, which does not answer MCP form requests. | Installed Desktop version and an end-to-end model turn are unverified.                                  |
| Claude Code 2.1.288            | Installed implementation contains form/URL capabilities and an elicitation handler. Official docs describe the form dialog.        | Native input through a Claude model is unverified. PATH reports 2.1.289 after the cached version check. |

Primary Cline evidence: [stdio capability declaration](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/mcp/client.ts#L232-L236), [stdio response dispatcher](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/mcp/client.ts#L441-L464), [HTTP client construction](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/mcp/client.ts#L677-L691), [Desktop hub initialization](https://github.com/cline/cline/blob/main/apps/examples/desktop-app/sidecar/context.ts#L1253-L1271), and [Desktop tool approval UI](https://github.com/cline/cline/blob/main/apps/examples/desktop-app/webview/components/views/chat/messages/tool-approval-panel.tsx#L38-L49).

Primary Claude evidence: [elicitation documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests) and [the 2.1.76 changelog entry](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2176).

The launcher preserves the installed runtime's consent mechanism. It supplies no approval shim for clients that lack elicitation. A compatible client's support for forms does not by itself prove that the desktop session binding is available.
