import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverLaunch } from './codex-cu.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const names = ['codex-cu', 'codex-browser'];
const skills = ['codex-windows-computer-use', 'codex-browser-use'];
const marker = '.codex-cu-managed.json';
const owned = `${JSON.stringify({ owner: 'codex-cu', format: 1 })}\n`;
const packageFiles = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/icon.png',
  'assets/icon.svg',
  '.mcp.json',
  '.gitignore',
  '.github/workflows/ci.yml',
  'package.json',
  'README.md',
  'PRIVACY.md',
  'LICENSE',
  'scripts/codex-cu.mjs',
  'scripts/install-agents.mjs',
  'tests/package.test.mjs',
  'tests/installer.test.mjs',
  ...skills.map((name) => `skills/${name}/SKILL.md`),
  'skills/codex-windows-computer-use/references/windows-interaction.md',
];

async function optional(filename) {
  try {
    return await readFile(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('An installation file cannot be read');
  }
}

function json(bytes) {
  try {
    const value = bytes ? JSON.parse(bytes) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new Error('An existing client JSON configuration is invalid');
  }
}

async function rejectLinks(filename, home) {
  for (
    let current = filename;
    current !== home;
    current = path.dirname(current)
  ) {
    if (current === path.dirname(current))
      throw new Error('Installation target is outside the selected home');
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Installation target contains a link');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function atomic(filename, bytes, backup = false, expected) {
  const previous = await optional(filename);
  if (
    expected !== undefined &&
    !(previous === null && expected === null) &&
    !previous?.equals(expected)
  )
    throw new Error(
      'Client configuration changed during installation. Retry after reviewing it',
    );
  if (previous?.equals(bytes)) return;
  await mkdir(path.dirname(filename), { recursive: true });
  if (backup && previous)
    await writeFile(`${filename}.codex-cu-backup-${randomUUID()}`, previous, {
      mode: 0o600,
      flag: 'wx',
    });
  const temporary = `${filename}.codex-cu-tmp-${randomUUID()}`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}

export function runCommand(command, args, env) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env,
        shell: false,
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
        });
      },
    );
  });
}

function clientPaths(home, env) {
  const cline =
    env.CLINE_MCP_SETTINGS_PATH?.trim() ||
    path.join(
      env.CLINE_DATA_DIR?.trim() ||
        path.join(env.CLINE_DIR?.trim() || path.join(home, '.cline'), 'data'),
      'settings',
      'cline_mcp_settings.json',
    );
  return {
    claude: path.join(home, '.claude.json'),
    cline,
    codex: path.join(home, '.codex', 'config.toml'),
  };
}

function matchesRegistration(server, launcher, mode, client) {
  return (
    server?.command === process.execPath &&
    JSON.stringify(server.args) === JSON.stringify([launcher, mode]) &&
    (!server.type || server.type === 'stdio') &&
    !server.url &&
    !server.headers &&
    !server.env &&
    (client !== 'cline' || server.disabled === false)
  );
}

export async function installAgents({
  install = false,
  clients = ['codex', 'claude', 'cline'],
  home = homedir(),
  source = sourceRoot,
  env = process.env,
  platform = process.platform,
  run = runCommand,
  discover = discoverLaunch,
} = {}) {
  if (
    !clients.length ||
    clients.some((client) => !['codex', 'claude', 'cline'].includes(client))
  )
    throw new Error('Choose codex, claude, or cline');
  home = path.resolve(home);
  const paths = clientPaths(home, env);
  const canonical = path.join(home, '.agents', 'plugins', 'codex-cu');
  const launcher = path.join(canonical, 'scripts', 'codex-cu.mjs');
  const configuration = {};
  const originals = {};
  for (const client of clients)
    originals[client] = await optional(paths[client]);
  for (const client of clients.filter((client) => client !== 'codex')) {
    configuration[client] = json(originals[client]);
    const servers = configuration[client].mcpServers;
    if (
      servers != null &&
      (typeof servers !== 'object' || Array.isArray(servers))
    )
      throw new Error('Existing MCP server settings are invalid');
  }
  let launch;
  try {
    launch = await discover({ mode: 'windows', parentEnv: env });
  } catch {
    if (install) throw new Error('Codex Windows runtime discovery failed');
  }
  const cli = launch?.sourceEnv?.CODEX_CLI_PATH;
  const validCli =
    typeof cli === 'string' &&
    path.isAbsolute(cli) &&
    path.basename(cli).toLowerCase() === 'codex.exe';
  const canonicalReady =
    (await optional(path.join(canonical, marker)))?.toString() === owned &&
    (await optional(launcher)) !== null;
  const status = {
    nativeReady: launch?.nativeConfigured === true,
    canonicalReady,
    clients: {},
  };
  const existingCodex = {};
  for (const client of clients) {
    status.clients[client] = {};
    for (const [index, name] of names.entries()) {
      const mode = index ? '--browser' : '--windows';
      if (client === 'codex') {
        const result = validCli
          ? await run(cli, ['mcp', 'get', name, '--json'], launch.env)
          : { code: 1 };
        existingCodex[name] = result.code === 0;
        let registration;
        try {
          registration = JSON.parse(result.stdout);
        } catch {}
        status.clients[client][name] = {
          checked: validCli,
          registered: result.code === 0,
          matchesInstalledConfiguration:
            canonicalReady &&
            registration?.enabled !== false &&
            matchesRegistration(
              registration?.transport,
              launcher,
              mode,
              client,
            ),
        };
      } else {
        const server = configuration[client].mcpServers?.[name];
        status.clients[client][name] = {
          checked: true,
          registered: Object.hasOwn(
            configuration[client].mcpServers ?? {},
            name,
          ),
          matchesInstalledConfiguration:
            canonicalReady &&
            matchesRegistration(server, launcher, mode, client),
        };
      }
    }
  }
  if (!install) return status;
  if (platform !== 'win32' || !status.nativeReady)
    throw new Error(
      'Installation requires an authorized Codex Windows native binding',
    );
  const diagnosis = await run(
    process.execPath,
    [path.join(source, 'scripts', 'codex-cu.mjs'), '--windows', '--diagnose'],
    env,
  );
  let ready = false;
  try {
    ready =
      diagnosis.code === 0 &&
      JSON.parse(diagnosis.stdout).nativeConfigured === true;
  } catch {}
  if (!ready)
    throw new Error('Native launcher diagnosis failed. No files changed');
  if (clients.includes('codex') && !validCli)
    throw new Error('The installed Codex executable is unavailable');

  const groups = [
    {
      directory: canonical,
      files: packageFiles.map((file) => [file, path.join(source, file)]),
    },
  ];
  for (const skill of skills) {
    const files = [
      ['SKILL.md', path.join(source, 'skills', skill, 'SKILL.md')],
    ];
    if (skill === skills[0])
      files.push([
        'references/windows-interaction.md',
        path.join(
          source,
          'skills',
          skill,
          'references',
          'windows-interaction.md',
        ),
      ]);
    for (const client of [
      'agents',
      ...clients.filter((client) => client !== 'cline'),
    ])
      groups.push({
        directory: path.join(home, `.${client}`, 'skills', skill),
        files,
      });
  }
  const writes = [];
  for (const group of groups) {
    await rejectLinks(group.directory, home);
    const ownership = await optional(path.join(group.directory, marker));
    if (ownership && ownership.toString() !== owned)
      throw new Error('An installation ownership marker is invalid');
    for (const [relative, origin] of group.files) {
      const target = path.join(group.directory, relative);
      await rejectLinks(target, home);
      const bytes = await readFile(origin);
      const previous = await optional(target);
      if (!ownership && previous && !previous.equals(bytes))
        throw new Error(
          'An unmanaged installation conflicts. No files changed',
        );
      writes.push([target, bytes]);
    }
    writes.push([path.join(group.directory, marker), Buffer.from(owned)]);
  }
  for (const client of clients) {
    if (!path.isAbsolute(paths[client]))
      throw new Error('Client configuration paths must be absolute');
    // An explicit Cline override can be outside home. Check its own parent for links.
    await rejectLinks(
      paths[client],
      paths[client].startsWith(`${home}${path.sep}`)
        ? home
        : path.parse(paths[client]).root,
    );
    if (client === 'codex') continue;
    const config = configuration[client];
    config.mcpServers ??= {};
    for (const [index, name] of names.entries()) {
      const prior = config.mcpServers[name] ?? {};
      if (typeof prior !== 'object' || Array.isArray(prior))
        throw new Error('An existing MCP entry is invalid');
      if (
        client === 'cline' &&
        prior.alwaysAllow != null &&
        (!Array.isArray(prior.alwaysAllow) ||
          prior.alwaysAllow.some((value) => typeof value !== 'string'))
      )
        throw new Error('Existing Cline tool approvals are invalid');
      const registration = { ...prior };
      for (const key of ['url', 'headers', 'env', 'type', 'transport'])
        delete registration[key];
      config.mcpServers[name] = {
        ...registration,
        command: process.execPath,
        args: [launcher, index ? '--browser' : '--windows'],
        ...(client === 'cline' ? { disabled: false, alwaysAllow: [] } : {}),
      };
    }
    writes.push([
      paths[client],
      Buffer.from(`${JSON.stringify(config, null, 2)}\n`),
      true,
      originals[client],
    ]);
  }
  for (const client of clients) {
    const observed = await optional(paths[client]);
    if (
      !(observed === null && originals[client] === null) &&
      !observed?.equals(originals[client])
    )
      throw new Error(
        'Client configuration changed during installation. No files changed',
      );
  }
  for (const write of writes) await atomic(...write);
  if (clients.includes('codex')) {
    const previous = await optional(paths.codex);
    if (
      !(previous === null && originals.codex === null) &&
      !previous?.equals(originals.codex)
    )
      throw new Error(
        'Codex configuration changed during installation. Retry after reviewing it',
      );
    if (
      previous &&
      names.some(
        (name) => !status.clients.codex[name].matchesInstalledConfiguration,
      )
    )
      await writeFile(
        `${paths.codex}.codex-cu-backup-${randomUUID()}`,
        previous,
        { mode: 0o600, flag: 'wx' },
      );
    for (const [index, name] of names.entries()) {
      if (status.clients.codex[name].matchesInstalledConfiguration) continue;
      if (
        existingCodex[name] &&
        (await run(cli, ['mcp', 'remove', name], launch.env)).code !== 0
      )
        throw new Error(
          'Codex MCP removal failed. Restore the private configuration backup',
        );
      if (
        (
          await run(
            cli,
            [
              'mcp',
              'add',
              name,
              '--',
              process.execPath,
              launcher,
              index ? '--browser' : '--windows',
            ],
            launch.env,
          )
        ).code !== 0
      )
        throw new Error(
          'Codex MCP registration failed. Restore the private configuration backup',
        );
    }
  }
  return { installed: true, clients, servers: names, skills };
}

function options(args) {
  const action = args.shift();
  if (!['--check', '--install'].includes(action))
    throw new Error(
      'Usage: node scripts/install-agents.mjs --check | --install [--clients codex,claude,cline]',
    );
  const clients = args.length
    ? args[0] === '--clients' && args.length === 2
      ? args[1].split(',')
      : null
    : undefined;
  if (clients === null || (action === '--check' && args.length))
    throw new Error('Unsupported installer arguments');
  return {
    install: action === '--install',
    ...(clients ? { clients: [...new Set(clients)] } : {}),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await installAgents(options(process.argv.slice(2))), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
