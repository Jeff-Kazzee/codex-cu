import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installAgents } from '../scripts/install-agents.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-cu-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const cli = path.join(home, 'runtime', 'codex.exe');
  const options = {
    home,
    env: {},
    platform: 'win32',
    discover: async () => ({
      nativeConfigured: true,
      sourceEnv: { CODEX_CLI_PATH: cli },
      env: {},
    }),
    run: async (command, args) => {
      calls.push({ command, args });
      if (args.includes('--diagnose'))
        return { code: 0, stdout: '{"nativeConfigured":true}' };
      if (args[1] === 'get') return { code: 1, stdout: '' };
      return { code: 0, stdout: '' };
    },
  };
  return { home, options, calls, cli };
}

async function putJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value));
}

test('check is read-only and reports no configuration values', async (t) => {
  const { home, options } = await fixture(t);
  await putJson(path.join(home, '.claude.json'), {
    mcpServers: { 'codex-cu': { env: { TOKEN: 'private-sentinel' } } },
  });
  const before = await readdir(home);
  const result = await installAgents(options);
  assert.equal(result.clients.claude['codex-cu'].registered, true);
  assert.equal(result.clients.claude['codex-browser'].registered, false);
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  assert.ok(!JSON.stringify(result).includes(home));
  assert.deepEqual(await readdir(home), before);
});

test('installation preserves unrelated configuration and resets only its own Cline approvals', async (t) => {
  const { home, options, calls, cli } = await fixture(t);
  const claude = path.join(home, '.claude.json');
  const cline = path.join(
    home,
    '.cline',
    'data',
    'settings',
    'cline_mcp_settings.json',
  );
  await putJson(claude, {
    theme: 'custom',
    projects: { keep: {} },
    mcpServers: { other: { command: 'unchanged' } },
  });
  await putJson(cline, {
    mcpServers: {
      'codex-cu': {
        command: 'old',
        type: 'http',
        url: 'https://example.com/stale',
        env: { OLD_TOKEN: 'keep-local' },
        alwaysAllow: ['already-approved'],
      },
      other: { url: 'https://example.com/mcp' },
    },
  });
  await installAgents({ ...options, install: true });
  const installedClaude = JSON.parse(await readFile(claude));
  const installedCline = JSON.parse(await readFile(cline));
  assert.equal(installedClaude.theme, 'custom');
  assert.deepEqual(installedClaude.projects, { keep: {} });
  assert.equal(installedClaude.mcpServers.other.command, 'unchanged');
  assert.deepEqual(installedCline.mcpServers['codex-cu'].alwaysAllow, []);
  assert.deepEqual(installedCline.mcpServers['codex-browser'].alwaysAllow, []);
  assert.equal(installedCline.mcpServers.other.url, 'https://example.com/mcp');
  assert.equal(installedCline.mcpServers['codex-cu'].disabled, false);
  assert.equal(installedCline.mcpServers['codex-cu'].type, undefined);
  assert.equal(installedCline.mcpServers['codex-cu'].url, undefined);
  assert.equal(installedCline.mcpServers['codex-cu'].env, undefined);
  assert.equal(
    installedClaude.mcpServers['codex-cu'].command,
    process.execPath,
  );
  assert.deepEqual(installedClaude.mcpServers['codex-browser'].args, [
    path.join(
      home,
      '.agents',
      'plugins',
      'codex-cu',
      'scripts',
      'codex-cu.mjs',
    ),
    '--browser',
  ]);
  assert.ok(
    (await readdir(home)).some((name) =>
      name.startsWith('.claude.json.codex-cu-backup-'),
    ),
  );
  assert.equal(calls.filter((call) => call.args[1] === 'remove').length, 0);
  assert.equal(
    calls.filter((call) => call.command === cli && call.args[1] === 'add')
      .length,
    2,
  );
  await readFile(
    path.join(home, '.agents', 'skills', 'codex-browser-use', 'SKILL.md'),
  );
  await readFile(
    path.join(home, '.codex', 'skills', 'codex-browser-use', 'SKILL.md'),
  );
  await readFile(
    path.join(home, '.claude', 'skills', 'codex-browser-use', 'SKILL.md'),
  );
  await assert.rejects(
    readFile(
      path.join(home, '.cline', 'skills', 'codex-browser-use', 'SKILL.md'),
    ),
    { code: 'ENOENT' },
  );
});

test('missing native binding and failed diagnosis both stop before writes', async (t) => {
  const { home, options } = await fixture(t);
  await assert.rejects(
    installAgents({
      ...options,
      install: true,
      discover: async () => ({ nativeConfigured: false }),
    }),
    /authorized/,
  );
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(
    installAgents({
      ...options,
      install: true,
      run: async () => ({ code: 1, stdout: '' }),
    }),
    /diagnosis/,
  );
  assert.deepEqual(await readdir(home), []);
});

test('an unmanaged skill conflict prevents all installation writes', async (t) => {
  const { home, options } = await fixture(t);
  const skill = path.join(
    home,
    '.agents',
    'skills',
    'codex-browser-use',
    'SKILL.md',
  );
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, 'user-owned instructions');
  await assert.rejects(
    installAgents({ ...options, install: true }),
    /unmanaged/,
  );
  assert.equal(await readFile(skill, 'utf8'), 'user-owned instructions');
  await assert.rejects(
    readFile(path.join(home, '.agents', 'plugins', 'codex-cu', 'README.md')),
    { code: 'ENOENT' },
  );
  await assert.rejects(readFile(path.join(home, '.claude.json')), {
    code: 'ENOENT',
  });
});

test('Cline overrides and selected clients restrict configuration writes', async (t) => {
  const { home, options, calls } = await fixture(t);
  const target = path.join(home, 'custom', 'cline-settings.json');
  await installAgents({
    ...options,
    install: true,
    clients: ['cline'],
    env: { CLINE_MCP_SETTINGS_PATH: target },
  });
  assert.ok(JSON.parse(await readFile(target)).mcpServers['codex-cu']);
  assert.equal(
    calls.some((call) => call.args[1] === 'add'),
    false,
  );
  await assert.rejects(readFile(path.join(home, '.claude.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(
    readFile(
      path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    ),
    { code: 'ENOENT' },
  );
});

test('invalid existing approval settings stop before writes', async (t) => {
  const { home, options } = await fixture(t);
  await putJson(
    path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    { mcpServers: { 'codex-cu': { alwaysAllow: '*' } } },
  );
  await assert.rejects(
    installAgents({ ...options, install: true }),
    /approvals/,
  );
  await assert.rejects(
    readFile(path.join(home, '.agents', 'plugins', 'codex-cu', 'README.md')),
    { code: 'ENOENT' },
  );
});

test('Codex removal is limited to existing names and preserves a configuration backup', async (t) => {
  const { home, options, calls } = await fixture(t);
  const config = path.join(home, '.codex', 'config.toml');
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, '# private original');
  const run = async (command, args, env) => {
    const result = await options.run(command, args, env);
    return args[1] === 'get' && args[2] === 'codex-cu'
      ? { code: 0, stdout: '{}' }
      : result;
  };
  await installAgents({ ...options, install: true, clients: ['codex'], run });
  assert.deepEqual(
    calls
      .filter((call) => call.args[1] === 'remove')
      .map((call) => call.args[2]),
    ['codex-cu'],
  );
  const backups = (await readdir(path.dirname(config))).filter((name) =>
    name.startsWith('config.toml.codex-cu-backup-'),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    await readFile(path.join(path.dirname(config), backups[0]), 'utf8'),
    '# private original',
  );
});

test('concurrent configuration changes prevent installation writes', async (t) => {
  const { home, options } = await fixture(t);
  const filename = path.join(home, '.claude.json');
  await putJson(filename, { userEdit: 'original' });
  const run = async (command, args, env) => {
    if (args.includes('--diagnose'))
      await putJson(filename, { userEdit: 'concurrent' });
    return options.run(command, args, env);
  };
  await assert.rejects(
    installAgents({ ...options, install: true, clients: ['claude'], run }),
    /changed during installation/,
  );
  assert.equal(JSON.parse(await readFile(filename)).userEdit, 'concurrent');
  await assert.rejects(
    readFile(path.join(home, '.agents', 'plugins', 'codex-cu', 'README.md')),
    { code: 'ENOENT' },
  );
});

test('check distinguishes legacy registrations from matching installed modes', async (t) => {
  const { home, options } = await fixture(t);
  await putJson(path.join(home, '.claude.json'), {
    mcpServers: { 'codex-cu': { command: 'old', args: ['old', '--browser'] } },
  });
  const before = await installAgents({ ...options, clients: ['claude'] });
  assert.equal(before.clients.claude['codex-cu'].registered, true);
  assert.equal(
    before.clients.claude['codex-cu'].matchesInstalledConfiguration,
    false,
  );
  await installAgents({
    ...options,
    install: true,
    clients: ['claude', 'cline'],
  });
  const after = await installAgents({
    ...options,
    clients: ['claude', 'cline'],
  });
  assert.equal(after.canonicalReady, true);
  assert.equal(
    after.clients.claude['codex-cu'].matchesInstalledConfiguration,
    true,
  );
  assert.equal(
    after.clients.cline['codex-browser'].matchesInstalledConfiguration,
    true,
  );
});

test('check parses Codex CLI registrations without returning transport values', async (t) => {
  const { home, options } = await fixture(t);
  await installAgents({ ...options, install: true, clients: ['codex'] });
  const launcher = path.join(
    home,
    '.agents',
    'plugins',
    'codex-cu',
    'scripts',
    'codex-cu.mjs',
  );
  const run = async (command, args, env) =>
    args[1] === 'get'
      ? {
          code: 0,
          stdout: JSON.stringify({
            transport: {
              type: 'stdio',
              command: process.execPath,
              args: [
                launcher,
                args[2] === 'codex-cu' ? '--windows' : '--browser',
              ],
            },
          }),
        }
      : options.run(command, args, env);
  const result = await installAgents({ ...options, clients: ['codex'], run });
  assert.equal(
    result.clients.codex['codex-cu'].matchesInstalledConfiguration,
    true,
  );
  assert.equal(
    result.clients.codex['codex-browser'].matchesInstalledConfiguration,
    true,
  );
  assert.ok(!JSON.stringify(result).includes(launcher));
});

test('skill refresh keeps matching enabled Codex registrations', async (t) => {
  const { home, options, calls } = await fixture(t);
  await installAgents({ ...options, install: true, clients: ['codex'] });
  const launcher = path.join(
    home,
    '.agents',
    'plugins',
    'codex-cu',
    'scripts',
    'codex-cu.mjs',
  );
  let enabled = true;
  const run = async (command, args, env) =>
    args[1] === 'get'
      ? {
          code: 0,
          stdout: JSON.stringify({
            enabled,
            transport: {
              type: 'stdio',
              command: process.execPath,
              args: [
                launcher,
                args[2] === 'codex-cu' ? '--windows' : '--browser',
              ],
            },
          }),
        }
      : options.run(command, args, env);
  calls.length = 0;
  await installAgents({ ...options, install: true, clients: ['codex'], run });
  assert.equal(
    calls.some((call) => ['add', 'remove'].includes(call.args[1])),
    false,
  );
  enabled = false;
  const disabled = await installAgents({ ...options, clients: ['codex'], run });
  assert.equal(
    disabled.clients.codex['codex-cu'].matchesInstalledConfiguration,
    false,
  );
  assert.equal(
    disabled.clients.codex['codex-browser'].matchesInstalledConfiguration,
    false,
  );
});
