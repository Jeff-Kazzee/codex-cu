# Privacy

The `codex-cu` launcher has no telemetry, analytics, or remote logging. It discovers an installed Codex runtime and forwards MCP traffic between your client and that runtime. It does not bundle a model or call a model provider itself.

Computer-use observations can include window titles, accessibility text, screenshots, document content, and browser page content. Your MCP client can send these observations and your instructions to the model provider you select. Your client's history, logging, retention, and provider policies apply. The Codex application and its runtime also operate under OpenAI's terms and privacy policies.

Relevant provider policies include [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/) and [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). Consult your selected client's and other services' policies for their handling of observations.

Use a dedicated app window or browser tab when unrelated personal content is visible. Do not put tokens, credentials, raw runtime manifests, connection endpoints, or private screenshots in support reports.

The launcher reads local runtime configuration to find the installed executable and its authorized session binding. These values stay local to the launch process. The repository contains no copied OpenAI binaries or user-specific connection values.

Windows input brings the selected window to the foreground. Browser sessions may already be signed in. Review the selected target and task before granting your MCP client permission to use either server.

Requested UI actions can write data into local apps or transmit it to the websites you select. The installer creates local backups of changed client configuration; these can contain personal settings or credentials already present in that configuration. Keep those backups private. The project has no developer-hosted service that receives or retains your data.

For questions, use [GitHub issues](https://github.com/Jeff-Kazzee/codex-cu/issues). Include the client version, operating system, and redacted error text.
