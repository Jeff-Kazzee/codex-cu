import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const numericVersion = /^\d+(?:\.\d+)*$/;
const secretName = /(?:^|_)(?:KEY|TOKEN|SECRET)$/i;
const serializedEnvironmentName = /^_*(?:VARLOCK|DMNO)_/i;

function validEnvironment(environment) {
  return (
    environment &&
    typeof environment === 'object' &&
    !Array.isArray(environment) &&
    Object.entries(environment).every(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        typeof value === 'string' &&
        !value.includes('\0'),
    )
  );
}

export function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0n) - (b[i] ?? 0n);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return left.localeCompare(right);
}

export function mergeEnvironment(parent, source) {
  const environment = {};
  // Windows environment names are case insensitive. Remove inherited aliases
  // before merging so the official manifest wins on every platform.
  const sourceNames = new Set(
    Object.keys(source).map((name) => name.toUpperCase()),
  );
  for (const [name, value] of Object.entries(parent)) {
    if (
      value !== undefined &&
      name.toUpperCase() !== 'NODE_OPTIONS' &&
      name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE' &&
      !secretName.test(name) &&
      !serializedEnvironmentName.test(name) &&
      !sourceNames.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return { ...environment, ...source };
}

async function requireFile(filename, label) {
  if (
    typeof filename !== 'string' ||
    !path.isAbsolute(filename) ||
    filename.includes('\0')
  ) {
    throw new Error(`${label} must be an absolute file path`);
  }
  try {
    if (!(await stat(filename)).isFile()) throw new Error();
    return await realpath(filename);
  } catch {
    throw new Error(`${label} file is unavailable`);
  }
}

async function readLaunch(versionPath, mode) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(versionPath, '.mcp.json'), 'utf8'),
    );
  } catch {
    throw new Error('Bundled MCP manifest is missing or invalid JSON');
  }
  const server = manifest?.mcpServers?.cua_repl;
  if (!server || typeof server !== 'object')
    throw new Error('Bundled cua_repl server is missing');
  const executable = await requireFile(server.command, 'Bundled command');
  if (
    !Array.isArray(server.args) ||
    !server.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
  ) {
    throw new Error('Bundled arguments must be strings');
  }
  if (!validEnvironment(server.env)) {
    throw new Error(
      'Bundled environment entries must be string values with valid names',
    );
  }
  // cua_repl is a bundled JS entry point, never a shell invocation.
  if (
    server.args.length !== 1 ||
    !path.isAbsolute(server.args[0]) ||
    path.basename(server.args[0]) !== 'cua-repl.mjs'
  ) {
    throw new Error('Bundled cua_repl entry point is incompatible');
  }
  await requireFile(server.args[0], 'Bundled cua_repl entry point');
  if (mode === 'browser')
    return {
      command: server.command,
      args: server.args,
      sourceEnv: server.env,
    };
  const native = await requireFile(
    server.env.CUA_REPL_NODE_REPL_PATH,
    'Bundled Windows node_repl',
  );
  if (
    path.basename(native).toLowerCase() !== 'node_repl.exe' ||
    path.dirname(native).toLowerCase() !==
      path.dirname(executable).toLowerCase()
  ) {
    throw new Error(
      'Bundled Windows node_repl must belong to the same runtime',
    );
  }
  return {
    command: server.env.CUA_REPL_NODE_REPL_PATH,
    args: [],
    sourceEnv: server.env,
  };
}

export async function queryCodexBinding({ command, env, timeoutMs = 10000 }) {
  const executable = await requireFile(command, 'Bundled Codex CLI');
  if (path.basename(executable).toLowerCase() !== 'codex.exe') {
    throw new Error('Bundled Codex CLI must be the Windows executable');
  }
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, ['mcp', 'get', 'node_repl', '--json'], {
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new Error('Bundled Codex CLI could not start'));
      return;
    }
    const output = [];
    let outputBytes = 0;
    let failure;
    let cleanup;
    const stop = (message) => {
      failure ??= new Error(message);
      cleanup ??= terminateOwnedChild(child);
    };
    const onInterrupt = () => {
      process.exitCode = 130;
      stop('Configured native binding query was interrupted');
    };
    const onTerminate = () => {
      process.exitCode = 143;
      stop('Configured native binding query was interrupted');
    };
    const removeSignalHandlers = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const timer = setTimeout(
      () => stop('Configured native binding query timed out'),
      timeoutMs,
    );
    child.stdout.on('data', (data) => {
      outputBytes += data.length;
      if (outputBytes > 1024 * 1024) {
        stop('Configured native binding query exceeded its output limit');
      } else if (!failure) {
        output.push(data);
      }
    });
    // CLI output can contain private configuration. Never relay either stream.
    child.stderr.resume();
    child.once('error', () => {
      clearTimeout(timer);
      removeSignalHandlers();
      reject(new Error('Bundled Codex CLI could not start'));
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      removeSignalHandlers();
      await cleanup;
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error('Configured native node_repl binding was not found'));
      else {
        try {
          resolve(JSON.parse(Buffer.concat(output).toString('utf8')));
        } catch {
          reject(
            new Error('Configured native binding query returned invalid JSON'),
          );
        }
      }
    });
  });
}

export async function configuredNativeLaunch(
  launch,
  { parentEnv = process.env, query = queryCodexBinding } = {},
) {
  const binding = await query({
    command: launch.sourceEnv.CODEX_CLI_PATH,
    env: mergeEnvironment(parentEnv, launch.sourceEnv),
  });
  if (binding?.enabled === false) {
    throw new Error('Configured native node_repl binding is disabled');
  }
  const transport = binding?.transport;
  if (
    !transport ||
    transport.type !== 'stdio' ||
    !Array.isArray(transport.args) ||
    transport.args.length !== 0
  ) {
    throw new Error(
      'Configured native binding must use stdio with no arguments',
    );
  }
  const configuredCommand = await requireFile(
    transport.command,
    'Configured native command',
  );
  const bundledCommand = await requireFile(
    launch.command,
    'Bundled Windows node_repl',
  );
  if (configuredCommand.toLowerCase() !== bundledCommand.toLowerCase()) {
    throw new Error(
      'Configured native binding does not match the bundled runtime',
    );
  }
  if (!validEnvironment(transport.env))
    throw new Error('Configured native environment is invalid');
  let services;
  try {
    services = JSON.parse(transport.env.NODE_REPL_TRUSTED_SERVICES);
  } catch {
    throw new Error('Configured native service map is invalid');
  }
  if (
    !services ||
    typeof services !== 'object' ||
    typeof services.sky !== 'string' ||
    !services.sky.trim()
  ) {
    throw new Error('Configured native binding does not supply a Sky service');
  }
  // Reuse existing configuration verbatim. No service, pipe, approval, or
  // authentication value is invented or rewritten by this launcher.
  const configuredNames = new Set(
    Object.keys(transport.env).map((name) => name.toUpperCase()),
  );
  const bundledEnv = Object.fromEntries(
    Object.entries(launch.sourceEnv).filter(
      ([name]) => !configuredNames.has(name.toUpperCase()),
    ),
  );
  const sourceEnv = { ...bundledEnv, ...transport.env };
  return {
    ...launch,
    sourceEnv,
    bindingSource: 'configured-node-repl',
    nativeConfigured: true,
  };
}

export async function discoverLaunch({
  cacheRoot = path.join(
    homedir(),
    '.codex',
    'plugins',
    'cache',
    'openai-bundled',
    'unified-computer-use',
  ),
  mode = process.platform === 'win32' ? 'windows' : 'browser',
  platform = process.platform,
  parentEnv = process.env,
  queryConfiguredBinding = queryCodexBinding,
} = {}) {
  if (mode !== 'windows' && mode !== 'browser')
    throw new Error('Unknown computer-use mode');
  if (mode === 'windows' && platform !== 'win32')
    throw new Error(
      'Windows mode requires Windows; use --browser on this platform',
    );
  let entries;
  try {
    entries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    throw new Error('Installed unified-computer-use bundle was not found');
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && numericVersion.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b, a));
  const skipped = [];
  for (const version of versions) {
    try {
      let launch = await readLaunch(path.join(cacheRoot, version), mode);
      if (mode === 'windows') {
        try {
          launch = await configuredNativeLaunch(launch, {
            parentEnv,
            query: queryConfiguredBinding,
          });
        } catch (error) {
          launch = {
            ...launch,
            bindingSource: 'not-configured',
            nativeConfigured: false,
            bindingProblem: error.message,
          };
        }
      }
      return {
        ...launch,
        mode,
        version,
        skipped,
        env: mergeEnvironment(parentEnv, launch.sourceEnv),
      };
    } catch (error) {
      skipped.push({ version, reason: error.message });
    }
  }
  throw new Error('No compatible installed cua_repl bundle was found');
}

export function diagnosticMetadata(launch) {
  return {
    mode: launch.mode,
    version: launch.version,
    executable: path.basename(launch.command),
    argumentCount: launch.args.length,
    sourceEnvironmentNames: Object.keys(launch.sourceEnv).sort(),
    skippedVersions: launch.skipped,
    ...(launch.mode === 'windows'
      ? {
          bindingSource: launch.bindingSource,
          nativeConfigured: launch.nativeConfigured,
          bindingProblem: launch.bindingProblem,
        }
      : {}),
  };
}

// Only this launcher's child subtree is eligible for termination. The Codex App
// native helper runs outside it; do not kill by executable name or pipe name.
export async function terminateOwnedChild(child, platform = process.platform) {
  if (
    !Number.isInteger(child.pid) ||
    child.pid <= 0 ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  if (platform === 'win32') {
    const systemRoot =
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    await new Promise((resolve) => {
      const killer = spawn(
        path.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true, shell: false },
      );
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('close', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already closed. */
    }
  }
}

export async function runLauncher(launch) {
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let stopping;
  let requestedCode;
  const stop = (code) => {
    requestedCode ??= code;
    stopping ??= terminateOwnedChild(child);
    return stopping;
  };
  const onEnd = () => {
    void stop(0);
  };
  const onInterrupt = () => {
    void stop(130);
  };
  const onTerminate = () => {
    void stop(143);
  };
  const onOutputError = () => {
    void stop(1);
  };
  process.stdin.on('end', onEnd);
  process.stdin.on('close', onEnd);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.stdout.on('error', onOutputError);
  child.stdin.on('error', () => {
    /* Child close supplies its actual exit status. */
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  const code = await new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(
        `codex-cu: bundled runtime could not start (${error.code ?? 'spawn error'})\n`,
      );
      resolve(1);
    });
    child.once('close', (exitCode, signal) =>
      resolve(
        requestedCode ??
          exitCode ??
          (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1),
      ),
    );
  });
  await stopping;
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.stdin.off('end', onEnd);
  process.stdin.off('close', onEnd);
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  process.stdout.off('error', onOutputError);
  return code;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) => !['--browser', '--windows', '--diagnose'].includes(arg),
    ) ||
    (args.includes('--browser') && args.includes('--windows'))
  ) {
    throw new Error(
      'Usage: node scripts/codex-cu.mjs [--windows | --browser] [--diagnose]',
    );
  }
  const mode = args.includes('--browser')
    ? 'browser'
    : args.includes('--windows')
      ? 'windows'
      : undefined;
  const launch = await discoverLaunch({ mode });
  if (args.includes('--diagnose')) {
    process.stdout.write(
      `${JSON.stringify(diagnosticMetadata(launch), null, 2)}\n`,
    );
    return 0;
  }
  if (launch.mode === 'windows' && !launch.nativeConfigured) {
    throw new Error(
      `Windows native binding is not configured: ${launch.bindingProblem}`,
    );
  }
  return await runLauncher(launch);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`codex-cu: ${error.message}\n`);
      process.exitCode ??= 1;
    });
}
