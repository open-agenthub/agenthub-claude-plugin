import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listLocalSessions, readLocalSession, writeEntries } from '../lib/local.mjs';
import { readTar, writeTar } from '../lib/tar.mjs';
import { parsePath, projectSlug } from '../lib/transcript.mjs';
import { planPull, planPush, remoteWorkdir, selectSession, TransferError } from '../lib/transfer.mjs';

const POD_CWD = '/workspace/repo';
const POD_SLUG = projectSlug(POD_CWD);
const SESSION = '2889d3b2-f4b8-4e9e-a197-ba7a696e2e6b';
const LOCAL_CWD = 'C:\\Users\\Mb\\GIT\\agenthub';

test('finds the only transcript in a pod archive', () => {
  const session = selectSession(podArchive());

  assert.deepEqual(session, { slug: POD_SLUG, sessionId: SESSION });
});

test('refuses to guess when the archive holds several transcripts', () => {
  const entries = [...podArchive(), file(`.claude/projects/-home-agent/${'other'}.jsonl`)];

  assert.throws(() => selectSession(entries), error =>
    error instanceof TransferError && /more than one transcript/.test(error.message));
  assert.deepEqual(selectSession(entries, SESSION), { slug: POD_SLUG, sessionId: SESSION });
});

test('says what is wrong when the archive has no transcript at all', () => {
  // A Codex or Cursor session stores a different home directory; so does a pod that died before
  // the agent wrote anything.
  assert.throws(() => selectSession([file('.claude/settings.json')]), error =>
    error instanceof TransferError && /has not run yet/.test(error.message));
});

test('pull moves the session into this machine\'s project folder and rewrites cwd', () => {
  const entries = podArchive();

  const plan = planPull(entries, { cwd: LOCAL_CWD, session: selectSession(entries) });

  assert.equal(plan.slug, 'C--Users-Mb-GIT-agenthub');
  assert.deepEqual(plan.files.map(entry => entry.name), [
    `.claude/projects/C--Users-Mb-GIT-agenthub/${SESSION}.jsonl`,
    `.claude/projects/C--Users-Mb-GIT-agenthub/${SESSION}/subagents/sub.jsonl`
  ]);
  const transcript = text(plan.files[0]).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(transcript[1].cwd, LOCAL_CWD);
  // The session id is what `claude --resume` takes, so pull must not change it.
  assert.equal(transcript[1].sessionId, SESSION);
});

test('pull leaves the sidecar bytes untouched', () => {
  const entries = podArchive();

  const plan = planPull(entries, { cwd: LOCAL_CWD, session: selectSession(entries) });

  assert.equal(text(plan.files[1]), '{"subagent":true}\n');
});

test('push puts the local transcript under the pod\'s project folder and session id', () => {
  const entries = podArchive();
  const session = selectSession(entries);
  const local = [
    file(`.claude/projects/C--Users-Mb-GIT-agenthub/${SESSION}.jsonl`,
      `${JSON.stringify({ type: 'user', cwd: LOCAL_CWD, sessionId: SESSION, uuid: 'local-turn' })}\n`)
  ];

  const plan = planPush(entries, local, { session, remoteCwd: POD_CWD });
  const transcript = plan.entries.find(
    entry => entry.name === `.claude/projects/${POD_SLUG}/${SESSION}.jsonl`);

  assert.ok(transcript, plan.entries.map(entry => entry.name).join('\n'));
  const lines = text(transcript).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].cwd, POD_CWD);
  assert.equal(lines[0].uuid, 'local-turn', 'the local turn has to survive the transfer');
});

test('push renames a transcript recorded under a different session id', () => {
  // A session started on the laptop has its own uuid. The pod resumes the id the hub stored, so
  // the upload has to arrive under that one or the pod comes back with no history.
  const entries = podArchive();
  const local = [
    file('.claude/projects/C--Users-Mb-GIT-agenthub/local-uuid.jsonl',
      `${JSON.stringify({ type: 'user', cwd: LOCAL_CWD, sessionId: 'local-uuid' })}\n`)
  ];

  const plan = planPush(entries, local, { session: selectSession(entries), remoteCwd: POD_CWD });
  const transcript = plan.entries.find(
    entry => entry.name === `.claude/projects/${POD_SLUG}/${SESSION}.jsonl`);

  assert.ok(transcript);
  assert.equal(JSON.parse(text(transcript).trim()).sessionId, SESSION);
});

test('push replaces the stored transcript instead of leaving two of them', () => {
  const entries = podArchive();
  const local = [file(`.claude/projects/C--Users-Mb-GIT-agenthub/${SESSION}.jsonl`, '{"type":"user","cwd":"x"}\n')];

  const plan = planPush(entries, local, { session: selectSession(entries), remoteCwd: POD_CWD });
  const transcripts = plan.entries.filter(entry => parsePath(entry.name)?.kind === 'transcript');

  assert.equal(transcripts.length, 1);
  // A stale sidecar from the pod would describe subagents the pushed transcript never ran.
  assert.equal(plan.entries.filter(entry => parsePath(entry.name)?.kind === 'sidecar').length, 0);
});

test('push keeps the rest of the agent home directory', () => {
  const entries = podArchive();
  const local = [file(`.claude/projects/C--Users-Mb-GIT-agenthub/${SESSION}.jsonl`, '{"type":"user","cwd":"x"}\n')];

  const plan = planPush(entries, local, { session: selectSession(entries), remoteCwd: POD_CWD });

  assert.ok(plan.entries.some(entry => entry.name === '.claude/settings.json'),
    'settings and the rest of the home directory must survive the upload');
});

test('remoteWorkdir follows the hub\'s rule of one repository, not of having repositories', () => {
  // AGENTHUB_WORKDIR is "/workspace/repo" for exactly one repository and "/workspace" otherwise.
  const repo = url => ({ url });
  assert.equal(remoteWorkdir({ slug: POD_SLUG }, { repos: [repo('git@example.com:x.git')] }), POD_CWD);
  assert.equal(remoteWorkdir({ slug: '-workspace' }, { repos: [] }), '/workspace');
  assert.equal(
    remoteWorkdir({ slug: '-workspace' }, { repos: [repo('git@example.com:x.git'), repo('git@example.com:y.git')] }),
    '/workspace',
    'two repositories land in /workspace/<name> and the agent works from the parent');
});

test('remoteWorkdir answers nothing rather than guessing wrong', () => {
  const repo = url => ({ url });
  // A custom workdir, or a session whose info could not be fetched: no cwd is better than a wrong
  // one in every line of the transcript, and the CLI then asks for --remote-cwd.
  assert.equal(remoteWorkdir({ slug: '-srv-project' }, { repos: [] }), null);
  assert.equal(remoteWorkdir({ slug: POD_SLUG }, null), null);
  // One repository guessed, but the clone failed and the pod fell back to /workspace: the archive
  // slug disagrees with the guess, so the guess is dropped.
  assert.equal(remoteWorkdir({ slug: '-workspace' }, { repos: [repo('git@example.com:x.git')] }), null);
});

test('a pulled session survives a real tar round trip', () => {
  const entries = podArchive();
  const plan = planPull(entries, { cwd: LOCAL_CWD, session: selectSession(entries) });

  const reparsed = readTar(writeTar(plan.files));

  assert.deepEqual(reparsed.map(entry => entry.name), plan.files.map(entry => entry.name));
  assert.equal(text(reparsed[0]), text(plan.files[0]));
});

// ------------------------------------------------------------------ filesystem

test('writes pulled files below the home directory and reads them back', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthub-home-'));
  const entries = podArchive();
  const plan = planPull(entries, { cwd: LOCAL_CWD, session: selectSession(entries) });

  const written = writeEntries(plan.files, { home });

  assert.equal(written.length, 2);
  assert.ok(existsSync(join(home, '.claude', 'projects', 'C--Users-Mb-GIT-agenthub', `${SESSION}.jsonl`)));
  assert.deepEqual(listLocalSessions(LOCAL_CWD, home).map(session => session.sessionId), [SESSION]);
  assert.deepEqual(readLocalSession(LOCAL_CWD, SESSION, home).map(entry => entry.name),
    plan.files.map(entry => entry.name));
});

test('refuses to overwrite a diverged local transcript without --force', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthub-home-'));
  const dir = join(home, '.claude', 'projects', 'C--Users-Mb-GIT-agenthub');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), '{"local":"work"}\n');
  const entries = podArchive();
  const plan = planPull(entries, { cwd: LOCAL_CWD, session: selectSession(entries) });

  assert.throws(() => writeEntries(plan.files, { home }), /--force/);
  assert.equal(readFileSync(join(dir, `${SESSION}.jsonl`), 'utf8'), '{"local":"work"}\n',
    'a refused pull must not have written anything');

  writeEntries(plan.files, { home, force: true });
  assert.notEqual(readFileSync(join(dir, `${SESSION}.jsonl`), 'utf8'), '{"local":"work"}\n');
});

test('rejects an entry whose name would escape the home directory', () => {
  // The names come from an archive built on another machine; ".." in one of them is how a tar
  // extraction writes outside the directory it was pointed at.
  const home = mkdtempSync(join(tmpdir(), 'agenthub-home-'));

  assert.throws(() => writeEntries([file('../escaped.jsonl')], { home }), /escapes the home directory/);
  assert.equal(existsSync(join(home, '..', 'escaped.jsonl')), false);
});

function podArchive() {
  return [
    file('.claude/settings.json', '{"theme":"dark"}'),
    file(`.claude/projects/${POD_SLUG}/${SESSION}.jsonl`, [
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION }),
      JSON.stringify({ type: 'user', cwd: POD_CWD, sessionId: SESSION, uuid: 'remote-turn' })
    ].join('\n') + '\n'),
    file(`.claude/projects/${POD_SLUG}/${SESSION}/subagents/sub.jsonl`, '{"subagent":true}\n')
  ];
}

function file(name, content = '{}\n') {
  return { name, type: '0', mode: 0o600, mtime: 1_700_000_000, data: new TextEncoder().encode(content) };
}

function text(entry) {
  return new TextDecoder().decode(entry.data);
}
