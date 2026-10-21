import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNodeVersion, nodeVersionError } from '../scripts/check-node-version.mjs';
import { requireVerifiedVendorMode, verifyChildNode } from '../scripts/check-child-node.mjs';

const verifiedAt = new Date('2026-10-21T00:00:00Z');

test('accepts the security releases and later patches on supported lines', () => {
  for (const version of ['22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0']) {
    assert.equal(nodeVersionError(version, verifiedAt), null, version);
  }
});

test('rejects vulnerable releases, including older minors with higher patch numbers', () => {
  for (const version of ['22.23.3', '22.22.99', '24.19.0', '24.21.0', '24.22.0', '24.21.99', '26.12.0', '26.11.99']) {
    assert.match(nodeVersionError(version, verifiedAt), /below the required/, version);
  }
});

test('rejects EOL, odd, unknown, prerelease, and malformed versions', () => {
  for (const version of ['18.20.8', '20.20.0', '23.11.0', '25.9.0', '27.0.0', '28.0.0']) {
    assert.match(nodeVersionError(version, verifiedAt), /unsupported/, version);
  }
  for (const version of ['', '22', 'v22.23.4', '022.23.4', '22.23.4-rc.1', '22.23.4+build', '22.23.4 extra', '24.99999999999999999999.1', null, 24, ['24.22.1']]) {
    assert.match(nodeVersionError(version, verifiedAt), /not a stable version/, version);
  }
});

function fakeProbe({ output, code = 0, signal = null, stderr, hang = false, startError = false }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const calls = [];
  return {
    child,
    calls,
    spawnNode: (...args) => {
      calls.push(args);
      queueMicrotask(() => {
        if (startError) return child.emit('error', new Error('private diagnostic'));
        if (hang) return;
        if (output !== undefined) child.stdout.emit('data', Buffer.from(output));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code, signal);
      });
      return child;
    },
  };
}

const fakeExecutable = path.resolve('test-node');
const resolveExecutable = async (filename) => filename;

test('vendor probe accepts patched supported lines and verifies the executable identity', async () => {
  for (const version of ['22.23.4', '24.22.1', '26.12.1']) {
    const probe = fakeProbe({ output: JSON.stringify({ version, execPath: fakeExecutable }) });
    assert.equal(await verifyChildNode(fakeExecutable, { spawnNode: probe.spawnNode, resolveExecutable }), fakeExecutable);
    assert.equal(probe.calls.length, 1);
    assert.equal(probe.calls[0][0], fakeExecutable);
    assert.equal(probe.calls[0][1][0], '--input-type=commonjs');
    assert.equal(probe.calls[0][1][1], '--eval');
    assert.match(probe.calls[0][1][2], /process\.versions\.node/);
    assert.match(probe.calls[0][1][2], /process\.execPath/);
    assert.equal(probe.calls[0][2].shell, false);
    assert.equal(probe.calls[0][2].windowsHide, true);
    assert.ok(Object.keys(probe.calls[0][2].env).every((name) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(name)));
  }
});

test('vendor probe rejects unsafe versions and malformed or mismatched identities', async () => {
  const outputs = [
    ...['20.20.0', '24.19.0', '24.21.0', '24.22.0', '26.12.0', '28.0.0', '24.22.1-rc.1'].map((version) => JSON.stringify({ version, execPath: fakeExecutable })),
    JSON.stringify({ version: '24.22.1', execPath: path.resolve('another-node') }),
    JSON.stringify({ version: ['24.22.1'], execPath: fakeExecutable }),
    JSON.stringify({ version: '24.22.1', execPath: 'relative-node' }),
    JSON.stringify({ version: '24.22.1', execPath: fakeExecutable, extra: true }),
    '{}', '[]', 'not-json',
  ];
  for (const output of outputs) {
    const probe = fakeProbe({ output });
    await assert.rejects(verifyChildNode(fakeExecutable, { spawnNode: probe.spawnNode, resolveExecutable }), { code: 'VENDOR_RUNTIME_VERIFICATION_REQUIRED' });
  }
});

test('vendor probe bounds output and duration and rejects diagnostic or failed processes', async () => {
  for (const options of [
    { output: 'x'.repeat(4097) },
    { output: '', stderr: 'private diagnostic' },
    { output: '', code: 1 },
    { output: '', signal: 'SIGTERM' },
    { startError: true },
    { hang: true },
  ]) {
    const probe = fakeProbe(options);
    await assert.rejects(verifyChildNode(fakeExecutable, { spawnNode: probe.spawnNode, resolveExecutable, timeoutMs: 20 }), (error) => {
      assert.equal(error.code, 'VENDOR_RUNTIME_VERIFICATION_REQUIRED');
      assert.ok(!error.message.includes('private diagnostic'));
      return true;
    });
    assert.equal(probe.child.killed, true);
  }
});

test('vendor probe refuses missing or invalid executable requests before spawning', async () => {
  for (const command of ['', 'relative-node', null]) {
    await assert.rejects(verifyChildNode(command, { spawnNode: () => assert.fail('must not spawn') }), { code: 'VENDOR_RUNTIME_VERIFICATION_REQUIRED' });
  }
  await assert.rejects(verifyChildNode(fakeExecutable, {
    spawnNode: () => assert.fail('must not spawn'),
    resolveExecutable: async () => { throw new Error('private file path'); },
  }), { code: 'VENDOR_RUNTIME_VERIFICATION_REQUIRED' });
});

test('vendor probe accepts the approved fixed test executable through the real Node contract', async () => {
  await verifyChildNode(process.execPath);
});

test('undocumented native mode is held without probing or starting a vendor app', () => {
  for (const mode of ['windows', undefined, 'unknown']) {
    assert.throws(() => requireVerifiedVendorMode(mode), { code: 'VENDOR_RUNTIME_VERIFICATION_REQUIRED' });
  }
  assert.doesNotThrow(() => requireVerifiedVendorMode('browser'));
  const launcher = readFileSync(new URL('../scripts/codex-cu.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /export async function queryCodexBinding[^]*?requireVerifiedVendorMode\('windows'\);/);
  assert.match(launcher, /requireVerifiedVendorMode\(mode\);[^]*?entries = await readdir/);
  assert.match(launcher, /await readLaunch[^]*?launch\.command = await verifyChildNode\(launch\.command\);/);
  assert.match(launcher, /export async function runLauncher\(launch\) \{\n  requireVerifiedVendorMode\(launch\.mode\);\n  const command = await verifyChildNode\(launch\.command\);\n  const child = spawn\(command,/);
});

test('expires each allowed release line on its scheduled EOL date', () => {
  for (const [version, before, end] of [
    ['22.23.4', '2027-04-29', '2027-04-30'],
    ['24.22.1', '2028-04-29', '2028-04-30'],
    ['26.12.1', '2029-04-29', '2029-04-30'],
  ]) {
    assert.equal(nodeVersionError(version, new Date(before)), null);
    assert.match(nodeVersionError(version, new Date(end)), /end of life/);
  }
});

test('CLI checks its executable and ignores version arguments and environment overrides', () => {
  const script = fileURLToPath(new URL('../scripts/check-node-version.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '20.0.0'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_VERSION: '20.0.0' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout + result.stderr, new RegExp(`Node.js ${process.versions.node.replaceAll('.', '\\.')} passes`));
});

test('assertion reads the actual process version and rejects an unsafe runtime', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    Object.defineProperty(process.versions, 'node', { ...descriptor, value: '24.21.0' });
    assert.throws(() => assertNodeVersion(), /below the required 24\.22\.1/);
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor);
  }
  assert.doesNotThrow(() => assertNodeVersion());
});

test('launcher guards imports before discovery and installer includes the guard', () => {
  const launcher = readFileSync(new URL('../scripts/codex-cu.mjs', import.meta.url), 'utf8');
  const installer = readFileSync(new URL('../scripts/install-agents.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /import \{ assertNodeVersion \} from '\.\/check-node-version\.mjs';/);
  assert.ok(launcher.indexOf('assertNodeVersion();') < launcher.indexOf('const numericVersion'));
  for (const file of ['scripts/check-node-version.mjs', 'scripts/check-child-node.mjs', 'tests/node-version.test.mjs', '.node-version']) {
    assert.ok(installer.includes("'" + file + "'"), file);
  }
  assert.match(installer, /import \{ discoverLaunch \} from '\.\/codex-cu\.mjs';/);
});

test('package checks require the real runtime guard before existing tests', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.node, '>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27');
  assert.equal(manifest.scripts.test, 'node scripts/check-node-version.mjs && node --test tests/package.test.mjs tests/installer.test.mjs tests/node-version.test.mjs');
  assert.equal(readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim(), '24.22.1');
});

test('CI verifies the action interpreter before immutable actions and pins project Node', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.ok(ci.indexOf('Assert-RunnerActionRuntimes -Runtimes') < ci.indexOf('- uses:'));
  assert.match(ci, /shell: pwsh/);
  assert.match(ci, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(ci, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(ci, /node-version: '24\.22\.1'/);
  assert.match(ci, /package-manager-cache: false/);
  assert.match(ci, /run: node --run test/);
  assert.doesNotMatch(ci, /continue-on-error|npm test/);
});

test('CI refuses the unverified client bootstrap before any action or package client', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const firstGuard = ci.indexOf("Assert-RunnerActionRuntimes -Runtimes @('node24')");
  const hold = ci.indexOf('      - name: Hold unverified runtime bootstrap');
  const firstAction = ci.indexOf('      - uses:');
  assert.ok(firstGuard >= 0 && hold > firstGuard && firstAction > hold);
  assert.match(ci.slice(hold, firstAction), /shell: pwsh\n        run: \|\n          throw 'CI_UNVERIFIED_BOOTSTRAP:/);
  assert.ok(ci.indexOf('run: node --run test') > firstAction);
  assert.doesNotMatch(ci, /continue-on-error|if:.*(?:always\(|failure\(|!cancelled\()/);
});
