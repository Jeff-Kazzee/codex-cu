import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { nodeVersionError } from './check-node-version.mjs';

function verificationError(reason) {
  const error = new Error(
    `VENDOR_RUNTIME_VERIFICATION_REQUIRED: ${reason}. Update through the official vendor release path. No runtime files were changed.`,
  );
  error.code = 'VENDOR_RUNTIME_VERIFICATION_REQUIRED';
  return error;
}

export function requireVerifiedVendorMode(mode) {
  if (mode !== 'browser') {
    throw verificationError(
      'Windows native mode is held because this package has no documented safe version-verification contract for node_repl',
    );
  }
}

export async function verifyChildNode(
  command,
  { spawnNode = spawn, resolveExecutable = realpath, timeoutMs = 5000 } = {},
) {
  if (
    typeof command !== 'string' ||
    !path.isAbsolute(command) ||
    command.includes('\0') ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  ) {
    throw verificationError('invalid bundled Node probe request');
  }
  let expected;
  try {
    expected = await resolveExecutable(command);
  } catch {
    throw verificationError('bundled Node executable is unavailable');
  }
  // The probe needs no session configuration or inherited Node loader options.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) =>
      /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(name) && typeof value === 'string',
    ),
  );
  const output = await new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    let bytes = 0;
    const chunks = [];
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      reject(verificationError(reason));
    };
    try {
      // Node's documented --eval contract runs before any vendor module loads.
      child = spawnNode(
        expected,
        ['--input-type=commonjs', '--eval', 'process.stdout.write(JSON.stringify({version:process.versions.node,execPath:process.execPath}))'],
        { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.once('error', () => fail('bundled Node probe could not start'));
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) fail('bundled Node probe exceeded its output limit');
        else if (!settled) chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', () => fail('bundled Node probe emitted diagnostics'));
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code !== 0 || signal) return fail('bundled Node probe failed');
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      timer = setTimeout(() => fail('bundled Node probe timed out'), timeoutMs);
    } catch {
      fail('bundled Node probe could not start');
    }
  });
  let info;
  try {
    info = JSON.parse(output);
    if (
      !info ||
      typeof info !== 'object' ||
      Array.isArray(info) ||
      Object.keys(info).length !== 2 ||
      typeof info.version !== 'string' ||
      typeof info.execPath !== 'string' ||
      !path.isAbsolute(info.execPath) ||
      nodeVersionError(info.version)
    ) {
      throw new Error();
    }
    const reported = await resolveExecutable(info.execPath);
    const normalize = (filename) =>
      process.platform === 'win32' ? filename.toLowerCase() : filename;
    if (normalize(expected) !== normalize(reported)) throw new Error();
  } catch {
    throw verificationError('bundled Node identity or security version is unverified');
  }
  return expected;
}
