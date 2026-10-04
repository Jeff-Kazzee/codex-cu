# Codex computer use

<img src=".claude-plugin/icon.png" width="96" height="96" alt="A window and pointer, the codex-cu plugin icon">

`codex-cu` connects an MCP client to the computer-use runtime installed by the Codex Windows desktop app. The package contains a Claude Code plugin, two reusable skills, and a launcher with separate Windows and browser modes. Cline Desktop, Cline CLI, and Codex can use the same launcher through MCP registration.

This is an independent project maintained by [Jeff Kazzee](https://github.com/Jeff-Kazzee). It is not an official OpenAI or Anthropic plugin.

## Requirements

- Windows with the Codex desktop app installed, running, and signed in.
- An existing authorized native `node_repl` binding in the same Windows user and desktop session.
- The app's installed `unified-computer-use` bundle.
- Node.js 20 or later, available as `node` to your MCP client.
- An MCP client that supports form elicitation for runtime requests before input.
- Browser support enabled in the Codex app for the browser you want to control.

The launcher discovers the newest compatible installed manifest at startup. It uses the app's existing executables and session configuration. You do not need to copy tokens, runtime paths, or connection endpoints into this package.

This package cannot supply a missing Codex runtime or establish a missing authorization binding. Successful MCP registration alone does not prove that another client can access the running desktop session. Test observation before requesting input. Runtime updates can change compatibility.

## Install in Claude Code

To register both MCP servers and their skills across your local clients, run the reviewed installer from a checkout:

```powershell
node scripts/install-agents.mjs --check
node scripts/install-agents.mjs --install
```

Use `--install --clients claude,cline` to select clients. The installer first verifies the Windows native binding. It copies this package into `~/.agents/plugins/codex-cu`, installs shared skills, and registers the two servers. Codex and Claude also receive skill copies in their own discovery directories. Cline reads the shared skills.

The installer preserves other server entries and client settings. Matching, enabled Codex registrations are left in place when skills are refreshed. It resets automatic tool approvals on its two Cline entries because replacing a server can change its capabilities. It backs up changed configurations beside their originals. It refuses conflicting unmanaged package or skill files. On Windows, backup privacy follows the parent directory's access controls.

Registration uses the official installed Codex executable. The installer never copies its runtime environment into client configuration. Check mode prints registration and configuration-match booleans without configuration values.

If installation stops after a client write or CLI error, the operation can be partial. Restore the affected `.codex-cu-backup-*` configuration files manually. Restore client settings before removing installed files. The installer has no automatic rollback or uninstall command.

Add this repository's marketplace and install the plugin:

```text
/plugin marketplace add Jeff-Kazzee/codex-cu
/plugin install codex-cu@codex-cu-marketplace
```

For a local checkout, use `/plugin marketplace add C:/tools/codex-cu` instead. Restart your session after installation. The plugin registers `codex-cu` for Windows and `codex-browser` for browser control. Claude Code loads the two skills from `skills/`.

To check a checkout without changing your global configuration:

```powershell
claude plugin validate --strict --json C:/tools/codex-cu
claude --plugin-dir C:/tools/codex-cu
```

The configuration uses `${CLAUDE_PLUGIN_ROOT}` so installed plugin caches can move without hardcoded paths. See [Claude Code's plugin manifest reference](https://code.claude.com/docs/en/plugins-reference).

## Install in Cline Desktop or CLI

Cline uses the MCP servers and skill folders in this package. Register them directly. Claude Code marketplace installation does not install a native Cline plugin.

1. Clone this repository into a stable directory, such as `C:/tools/codex-cu`.
2. Merge the following servers into `~/.cline/data/settings/cline_mcp_settings.json`.
3. Copy the two folders under `skills/` into `~/.agents/skills/`.
4. In Cline Desktop, check **Customize**, then **Installed MCP**, and enable the two servers. Check **Skills** for the installed skills.
5. Restart Cline CLI or refresh the Desktop session before testing.

```json
{
  "mcpServers": {
    "codex-cu": {
      "command": "node",
      "args": ["C:/tools/codex-cu/scripts/codex-cu.mjs", "--windows"],
      "disabled": false,
      "alwaysAllow": []
    },
    "codex-browser": {
      "command": "node",
      "args": ["C:/tools/codex-cu/scripts/codex-cu.mjs", "--browser"],
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

Replace `C:/tools/codex-cu` with your actual checkout path. Preserve your existing server entries. Cline CLI uses the shared settings path above, unless `CLINE_DIR`, `CLINE_DATA_DIR`, or `CLINE_MCP_SETTINGS_PATH` overrides it. Cline's [storage resolver](https://github.com/cline/cline/blob/main/sdk/packages/shared/src/storage/paths.ts) defines both the MCP settings path and `~/.agents/skills/` discovery.

If your Desktop version has a separate MCP configuration editor, merge these entries there through **Installed MCP**. Cline can also read global skills from `~/.cline/skills/`. Avoid installing duplicate copies of the same skill.

## Register in Codex

From a stable checkout, register both modes:

```powershell
codex mcp add codex-cu -- node C:/tools/codex-cu/scripts/codex-cu.mjs --windows
codex mcp add codex-browser -- node C:/tools/codex-cu/scripts/codex-cu.mjs --browser
```

Copy the two skill folders into `~/.codex/skills/`, or put them in your project's `.agents/skills/`. Restart your session and check that the `js` tools are available.

## Try an observation

Ask your agent to use `codex-windows-computer-use` to list open app windows and inspect a selected window. For browsers, ask it to use `codex-browser-use` to inspect an existing tab. The skills guide initialization and require the agent to read runtime documentation before interaction.

Windows screenshots can capture an occluded window, but input activates the target window. This package does not provide background typing. Browser access depends on the app's connected browser sessions.

To diagnose discovery without starting an interactive server:

```powershell
node C:/tools/codex-cu/scripts/codex-cu.mjs --windows --diagnose
node C:/tools/codex-cu/scripts/codex-cu.mjs --browser --diagnose
```

An unavailable binding, missing bundle, locked desktop, or unsupported browser requires the user to repair the app setup. Do not replace the installed runtime with downloaded helpers or guessed connection values.

## Development and support

Run `npm test` in this directory for package checks. Run `claude plugin validate --strict --json .` for Claude's manifest validation. Test both modes through your actual MCP client to verify session compatibility.

Read [the privacy notice](PRIVACY.md) before exposing app or browser content to an agent. Report redacted errors through [GitHub issues](https://github.com/Jeff-Kazzee/codex-cu/issues).

App and browser observations can contain personal information. Your MCP client can send observations to its selected model provider and retain them in conversation history. Requested UI actions can write data into local apps or submit it to the websites you choose. The installer also creates local backups of changed client configuration. This project runs no hosted data service and does not retain data on a developer server; the client's, runtime's, and selected services' policies apply.

The MIT license covers the original wrapper, skills, and documentation. OpenAI runtime packages, applications, and binaries are separate dependencies with their own terms. This repository does not redistribute them.
