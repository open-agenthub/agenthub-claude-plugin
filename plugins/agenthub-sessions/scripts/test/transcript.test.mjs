import assert from 'node:assert/strict';
import test from 'node:test';

import { listProjects, parsePath, projectSlug, replaceSession, retarget, rewriteTranscript, sessionEntries }
  from '../lib/transcript.mjs';

test('derives the project folder the way Claude Code does', () => {
  // Both expectations are taken from real folders on disk, not from reading the encoder: a
  // Windows path recorded by the CLI, and a probe directory created to settle what happens to
  // underscores, dots and spaces.
  assert.equal(projectSlug('C:\\Users\\Mb\\GIT\\agenthub'), 'C--Users-Mb-GIT-agenthub');
  assert.equal(projectSlug('/tmp/probe_a.b-c d'), '-tmp-probe-a-b-c-d');
  assert.equal(projectSlug('/workspace/repo'), '-workspace-repo');
});

test('splits transcript, sidecar and unrelated paths', () => {
  const session = '2889d3b2-f4b8-4e9e-a197-ba7a696e2e6b';
  assert.deepEqual(parsePath(`.claude/projects/-workspace-repo/${session}.jsonl`),
    { slug: '-workspace-repo', sessionId: session, kind: 'transcript', tail: `${session}.jsonl` });
  assert.equal(parsePath(`.claude/projects/-workspace-repo/${session}/subagents/x.jsonl`).kind, 'sidecar');
  assert.equal(parsePath('.claude/settings.json'), null);
  // GNU tar writes "./" in front of every member when told to archive ".".
  assert.equal(parsePath(`./.claude/projects/-workspace-repo/${session}.jsonl`).sessionId, session);
});

test('lists the projects and sessions an archive holds', () => {
  const entries = [
    file('.claude/projects/-workspace-repo/one.jsonl'),
    file('.claude/projects/-workspace-repo/one/subagents/a.jsonl'),
    file('.claude/projects/-home-agent/two.jsonl'),
    file('.claude/settings.json')
  ];

  assert.deepEqual(listProjects(entries).sort((a, b) => a.slug.localeCompare(b.slug)), [
    { slug: '-home-agent', sessions: ['two'] },
    { slug: '-workspace-repo', sessions: ['one'] }
  ]);
});

test('collects a session with its sidecars and nothing else', () => {
  const entries = [
    file('.claude/projects/-workspace-repo/one.jsonl'),
    file('.claude/projects/-workspace-repo/one/subagents/a.jsonl'),
    file('.claude/projects/-workspace-repo/other.jsonl'),
    file('.claude/projects/-workspace-repo/other/subagents/b.jsonl')
  ];

  assert.deepEqual(sessionEntries(entries, '-workspace-repo', 'one').map(entry => entry.name), [
    '.claude/projects/-workspace-repo/one.jsonl',
    '.claude/projects/-workspace-repo/one/subagents/a.jsonl'
  ]);
});

test('rewrites cwd on every line and leaves the rest of each line alone', () => {
  const text = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'abc' }),
    JSON.stringify({ type: 'user', cwd: '/workspace/repo', sessionId: 'abc', uuid: 'u1', gitBranch: 'main' })
  ].join('\n');

  const result = rewriteTranscript(text, { cwd: 'C:\\Users\\Mb\\GIT\\agenthub' });
  const lines = result.split('\n').map(line => JSON.parse(line));

  assert.equal(lines[1].cwd, 'C:\\Users\\Mb\\GIT\\agenthub');
  assert.equal(lines[1].uuid, 'u1');
  assert.equal(lines[1].gitBranch, 'main', 'the recorded branch is history, not a path to fix');
  assert.equal(lines[1].sessionId, 'abc', 'sessionId stays unless a new one was asked for');
  // A line without cwd must not grow one: Claude Code reads these by type, and an unexpected
  // field on a mode record is a change to data the agent wrote.
  assert.equal('cwd' in lines[0], false);
});

test('rewrites sessionId when the target session differs', () => {
  const text = JSON.stringify({ type: 'user', cwd: '/x', sessionId: 'old', uuid: 'u1' });

  const line = JSON.parse(rewriteTranscript(text, { cwd: '/y', sessionId: 'new' }));

  assert.equal(line.sessionId, 'new');
  assert.equal(line.cwd, '/y');
});

test('passes through a line that is not JSON', () => {
  // A transcript captured while the agent was writing ends mid-line. Dropping it would also drop
  // the complete turn before it, because the file would no longer parse as a whole.
  const text = `${JSON.stringify({ type: 'user', cwd: '/a' })}\n{"truncated":`;

  const result = rewriteTranscript(text, { cwd: '/b' });

  assert.equal(result.split('\n')[1], '{"truncated":');
  assert.equal(JSON.parse(result.split('\n')[0]).cwd, '/b');
});

test('keeps a trailing newline, which every transcript on disk has', () => {
  const text = `${JSON.stringify({ type: 'user', cwd: '/a' })}\n`;

  assert.ok(rewriteTranscript(text, { cwd: '/b' }).endsWith('\n'));
});

test('retargets a transcript and its sidecars to another project and session', () => {
  assert.equal(retarget('.claude/projects/-workspace-repo/old.jsonl', 'C--p', 'new'),
    '.claude/projects/C--p/new.jsonl');
  assert.equal(retarget('.claude/projects/-workspace-repo/old/subagents/a.jsonl', 'C--p', 'new'),
    '.claude/projects/C--p/new/subagents/a.jsonl');
});

test('replacing a session drops its old files and keeps everything else', () => {
  const entries = [
    file('.claude/settings.json'),
    file('.claude/projects/-workspace-repo/one.jsonl'),
    file('.claude/projects/-workspace-repo/one/subagents/stale.jsonl'),
    file('.claude/projects/-workspace-repo/other.jsonl')
  ];

  const result = replaceSession(entries, {
    slug: '-workspace-repo',
    sessionId: 'one',
    files: [file('.claude/projects/-workspace-repo/one.jsonl')]
  });

  assert.deepEqual(result.map(entry => entry.name), [
    '.claude/settings.json',
    '.claude/projects/-workspace-repo/other.jsonl',
    '.claude/projects/-workspace-repo/one.jsonl'
  ]);
});

function file(name, content = '{}\n') {
  return { name, type: '0', mode: 0o600, mtime: 1, data: new TextEncoder().encode(content) };
}
