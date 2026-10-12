import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidates, select, importRollout } from '../lib/codex.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const entry = (uuid = id) => ({ name: `.codex/sessions/2026/10/01/rollout-${uuid}.jsonl`, type: '0',
  data: Buffer.from([
    JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: '/workspace/repo', timestamp: '2026-10-01T12:00:00Z' } }),
    JSON.stringify({ type: 'turn_context', payload: { cwd: '/workspace/repo', approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } }),
    '{"type":"response_item","payload":{"text":"keep /workspace/repo exactly"}}'
  ].join('\n') + '\n') });

test('uses remembered main thread and rejects ambiguous archives and foreign files', () => {
  const second = entry('22345678-1234-1234-1234-123456789abc');
  assert.throws(() => select([entry(), second]), /Multiple/);
  assert.equal(select([entry(), second, { name: './.codex/agenthub-thread-id', data: Buffer.from(id) }]).id, id);
  assert.equal(select([entry(), second], '22345678-1234-1234-1234-123456789abc').id, '22345678-1234-1234-1234-123456789abc');
  assert.equal(candidates([{ ...entry(), name: '../.codex/sessions/evil.jsonl' }]).length, 0);
  assert.throws(() => select([]), /no Codex/);
});

test('imports a new local thread, preserves messages, excludes config and refuses overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-codex-test-'));
  try {
    const result = importRollout(select([entry()]), { cwd: root, codexHome: root });
    assert.notEqual(result.threadId, id);
    const rows = readFileSync(result.file, 'utf8').trimEnd().split('\n');
    assert.equal(JSON.parse(rows[0]).payload.cwd, root);
    assert.equal(JSON.parse(rows[0]).payload.id, result.threadId);
    assert.equal(JSON.parse(rows[1]).payload.approval_policy, undefined);
    assert.equal(JSON.parse(rows[1]).payload.sandbox_policy, undefined);
    assert.equal(rows[2], '{"type":"response_item","payload":{"text":"keep /workspace/repo exactly"}}');
    assert.equal(existsSync(join(root, 'auth.json')), false);
    assert.throws(() => importRollout(select([entry()]), { cwd: root, codexHome: root, id: result.threadId }), /EEXIST/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
