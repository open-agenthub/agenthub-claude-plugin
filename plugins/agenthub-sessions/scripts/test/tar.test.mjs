import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { readTar, writeTar } from '../lib/tar.mjs';

// The archives on both ends of a transfer are produced and consumed by GNU tar inside the session
// pod, so these tests run against the real `tar` binary rather than against this module's own
// output. A reader and a writer that only agree with each other is the failure this guards.
const tar = (args, cwd) => execFileSync('tar', args, { cwd, encoding: 'buffer' });
const hasGnuTar = (() => {
  try { return execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('GNU tar'); }
  catch { return false; }
})();

const workspace = () => mkdtempSync(join(tmpdir(), 'agenthub-tar-'));
const LONG = `.claude/projects/-workspace-repo/${'a'.repeat(36)}/subagents/${'b'.repeat(36)}.jsonl`;

test('reads an archive GNU tar produced, including a path over 100 characters', { skip: !hasGnuTar }, () => {
  const dir = workspace();
  mkdirSync(join(dir, 'home', '.claude', 'projects', '-workspace-repo', 'a'.repeat(36), 'subagents'),
    { recursive: true });
  writeFileSync(join(dir, 'home', '.claude', 'projects', '-workspace-repo', 'session.jsonl'), '{"a":1}\n');
  writeFileSync(join(dir, 'home', ...LONG.split('/')), '{"sub":true}\n');
  tar(['czf', 'state.tgz', '-C', join(dir, 'home'), '.claude'], dir);

  const entries = readTar(gunzipSync(readFileSync(join(dir, 'state.tgz'))));
  const names = entries.map(entry => entry.name.replace(/^\.\//, ''));

  assert.ok(names.includes('.claude/projects/-workspace-repo/session.jsonl'), names.join('\n'));
  assert.ok(names.includes(LONG), `long path lost; got:\n${names.join('\n')}`);
  const long = entries.find(entry => entry.name.replace(/^\.\//, '') === LONG);
  assert.equal(new TextDecoder().decode(long.data), '{"sub":true}\n');
});

test('writes an archive GNU tar extracts, long paths included', { skip: !hasGnuTar }, () => {
  const dir = workspace();
  const archive = writeTar([
    entry('.claude/projects/-workspace-repo/session.jsonl', '{"a":1}\n'),
    entry(LONG, '{"sub":true}\n')
  ]);
  writeFileSync(join(dir, 'state.tgz'), gzipSync(Buffer.from(archive)));
  mkdirSync(join(dir, 'out'));

  // Relative paths on purpose: GNU tar reads "C:\..." as a remote host specification.
  // stderr is captured so any warning fails the test — that is where a broken checksum or a
  // short final record would show up while the extraction still appeared to succeed.
  const output = execFileSync('tar', ['xzf', 'state.tgz', '-C', 'out'],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  assert.equal(output, '');
  assert.equal(readFileSync(join(dir, 'out', '.claude/projects/-workspace-repo/session.jsonl'), 'utf8'), '{"a":1}\n');
  assert.equal(readFileSync(join(dir, 'out', ...LONG.split('/')), 'utf8'), '{"sub":true}\n');
});

test('round-trips names, modes and content through this module', () => {
  const original = [
    entry('.claude/projects/-workspace/short.jsonl', 'one\n'),
    entry(LONG, 'two\n'),
    entry('.claude/settings.json', '{}')
  ];

  const parsed = readTar(writeTar(original));

  assert.deepEqual(parsed.map(e => e.name), original.map(e => e.name));
  assert.deepEqual(
    parsed.map(e => new TextDecoder().decode(e.data)),
    original.map(e => new TextDecoder().decode(e.data)));
  assert.deepEqual(parsed.map(e => e.mode), original.map(e => e.mode));
});

test('stops at the end-of-archive marker instead of reading the padding as entries', () => {
  const archive = writeTar([entry('.claude/projects/-workspace/a.jsonl', 'x')]);

  assert.equal(archive.length % (20 * 512), 0, 'archive should fill a 20-block record');
  assert.equal(readTar(archive).length, 1);
});

test('keeps a file whose size is an exact multiple of the block size', () => {
  // A 512-byte file leaves no partial block, which is where an off-by-one in the padding maths
  // swallows the following header.
  const payload = 'x'.repeat(512);
  const parsed = readTar(writeTar([
    entry('.claude/projects/-workspace/exact.jsonl', payload),
    entry('.claude/projects/-workspace/after.jsonl', 'after')
  ]));

  assert.equal(parsed.length, 2);
  assert.equal(new TextDecoder().decode(parsed[0].data), payload);
  assert.equal(new TextDecoder().decode(parsed[1].data), 'after');
});

test('preserves bytes that are not valid UTF-8', () => {
  // Transcripts carry tool output, which can hold any byte sequence.
  const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
  const parsed = readTar(writeTar([
    { name: '.claude/projects/-workspace/binary.jsonl', type: '0', mode: 0o600, mtime: 1, data: raw }
  ]));

  assert.deepEqual([...parsed[0].data], [...raw]);
});

function entry(name, content) {
  return { name, type: '0', mode: 0o600, mtime: 1_700_000_000, data: new TextEncoder().encode(content) };
}
