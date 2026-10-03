import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(root, relative), 'utf8'));

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const filename = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Export must contain files: ${entry.name}`);
    if (entry.isDirectory()) result.push(...await filesIn(filename));
    else result.push(filename);
  }
  return result;
}

test('marketplace resolves the plugin inside the standalone export', async () => {
  const plugin = await readJson('.claude-plugin/plugin.json');
  const marketplace = await readJson('.claude-plugin/marketplace.json');
  const packageManifest = await readJson('package.json');
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.source, '.');
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.version, plugin.version);
  assert.equal(packageManifest.version, plugin.version);
  assert.equal(plugin.license, 'MIT');
  assert.equal(new URL(plugin.supportUrl).hostname, 'github.com');
  assert.match(plugin.privacyPolicyUrl, /\/PRIVACY\.md$/);
});

test('MCP modes share an included launcher without baked runtime configuration', async () => {
  const { mcpServers } = await readJson('.mcp.json');
  assert.deepEqual(Object.keys(mcpServers).sort(), ['codex-browser', 'codex-cu']);
  for (const [name, mode] of [['codex-cu', '--windows'], ['codex-browser', '--browser']]) {
    const server = mcpServers[name];
    assert.deepEqual(server, {
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/scripts/codex-cu.mjs', mode],
    });
    assert.ok((await lstat(path.join(root, 'scripts/codex-cu.mjs'))).isFile());
  }
});

test('skills have discoverable frontmatter and contained, existing references', async () => {
  for (const name of ['codex-windows-computer-use', 'codex-browser-use']) {
    const filename = path.join(root, 'skills', name, 'SKILL.md');
    const content = await readFile(filename, 'utf8');
    assert.match(content, /^---\r?\n/);
    assert.match(content, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(content, /^description: .+/m);
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^https?:/.test(target) || target.startsWith('#')) continue;
      const resolved = path.resolve(path.dirname(filename), target);
      const relative = path.relative(root, resolved);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.ok((await lstat(resolved)).isFile(), `Missing reference: ${target}`);
    }
  }
});

test('export excludes binaries, session captures, local paths, and literal credentials', async () => {
  const forbiddenNames = /(?:\.exe|\.dll|\.node|\.jsonl|\.log|\.png|\.jpe?g|\.webp)$/i;
  const privatePath = /C:[\\/]+Users[\\/]+(?!USERNAME(?:[\\/]|$))[^\s"'`]+/i;
  const privatePipe = /\\\\\.\\pipe\\[A-Za-z0-9_-]+/;
  const credential = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  for (const filename of await filesIn(root)) {
    const relative = path.relative(root, filename);
    assert.ok(!forbiddenNames.test(relative), `Unexpected private or binary artifact: ${relative}`);
    assert.ok(!/^\.env(?:\.|$)/.test(path.basename(filename)), `Environment capture: ${relative}`);
    const content = await readFile(filename, 'utf8');
    assert.ok(!privatePath.test(content), `User-specific path: ${relative}`);
    assert.ok(!privatePipe.test(content), `Session endpoint: ${relative}`);
    assert.ok(!credential.test(content), `Literal credential: ${relative}`);
  }
});
