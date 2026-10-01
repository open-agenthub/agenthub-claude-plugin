#!/usr/bin/env node
// Moves one Claude Code session between an Open AgentHub server and this machine.
//
// The hub already keeps every session's state: when a pod stops it uploads its agent home
// directory, and a resume unpacks that archive back into the next pod. This tool reaches the same
// archive through the hub's remote API, so continuing a session locally is a download plus a path
// rewrite, and handing it back is an upload.

import { gunzipSync, gzipSync } from 'node:zlib';

import { Hub, HubError } from './lib/api.mjs';
import { CONFIG_FILE, loadConfig, saveConfig } from './lib/config.mjs';
import { listLocalSessions, projectDir, readLocalSession, writeEntries } from './lib/local.mjs';
import { readTar, writeTar } from './lib/tar.mjs';
import { planPull, planPush, remoteWorkdir, selectSession, TransferError } from './lib/transfer.mjs';

const USAGE = `agenthub-session — continue an Open AgentHub session on this machine, or hand it back

  list                          Sessions on the hub, with the ones that can be transferred
  pull <session-id>             Download a session's transcript into this project
  push <session-id>             Upload this project's transcript into that hub session
  local                         Transcripts recorded for this directory
  login --url <u> --token <t>   Store hub url and token in ${CONFIG_FILE}

Options
  --session <id>    Which transcript inside the archive (only needed when it holds several)
  --dir <path>      Treat <path> as the project directory instead of the current one
  --remote-cwd <p>  push: the directory the pod works in, when it is not /workspace[/repo]
  --force           pull: overwrite a local transcript that has diverged
  --json            Machine-readable output

Configuration comes from AGENTHUB_URL and AGENTHUB_TOKEN, or from ${CONFIG_FILE}.

A session has to be paused before a push: a running pod writes its own state over the upload
when it stops.`;

async function main(argv) {
  const { command, positional, flags } = parseArgs(argv);
  if (!command || flags.help) return print(USAGE);

  switch (command) {
    case 'login': return login(flags);
    case 'list': return list(flags);
    case 'local': return local(flags);
    case 'pull': return pull(positional[0], flags);
    case 'push': return push(positional[0], flags);
    default: throw new TransferError(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

function login(flags) {
  if (!flags.url || !flags.token) throw new TransferError('login needs both --url and --token.');
  const path = saveConfig({ url: flags.url, token: flags.token });
  print(`Stored hub url and token in ${path}`);
}

async function list(flags) {
  const sessions = await hub().listSessions();
  if (flags.json) return print(JSON.stringify(sessions, null, 2));
  if (!sessions?.length) return print('No sessions on the hub.');
  print('phase       id                                    title');
  for (const session of sessions) {
    print(`${(session.phase ?? '?').padEnd(11)} ${String(session.id).padEnd(37)} ${session.title ?? ''}`);
  }
  print('\nPull needs a stored archive, which a session has once it has run. Push needs it paused.');
}

function local(flags) {
  const cwd = flags.dir ?? process.cwd();
  const sessions = listLocalSessions(cwd);
  if (flags.json) {
    return print(JSON.stringify(
      sessions.map(session => ({ ...session, modified: session.modified.toISOString() })), null, 2));
  }
  if (!sessions.length) return print(`No transcripts in ${projectDir(cwd)}`);
  print(`Transcripts for ${cwd}:`);
  for (const session of sessions) print(`  ${session.sessionId}  ${session.modified.toISOString()}`);
}

async function pull(id, flags) {
  if (!id) throw new TransferError('pull needs a session id. Run `list` to see them.');
  const cwd = flags.dir ?? process.cwd();
  const entries = readTar(gunzipSync(await requireArchive(id)));
  const session = selectSession(entries, flags.session);
  const plan = planPull(entries, { cwd, session });
  const written = writeEntries(plan.files, { force: Boolean(flags.force) });

  if (flags.json) {
    return print(JSON.stringify(
      { sessionId: plan.sessionId, projectDir: projectDir(cwd), files: written }, null, 2));
  }
  print(`Wrote ${written.length} file(s) to ${projectDir(cwd)}`);
  print(`\nContinue it here:\n  claude --resume ${plan.sessionId}`);
  print('\nTo hand it back afterwards: pause the session in the hub, then');
  print(`  agenthub-session push ${id}`);
}

async function push(id, flags) {
  if (!id) throw new TransferError('push needs the hub session id to push into.');
  const cwd = flags.dir ?? process.cwd();
  const entries = readTar(gunzipSync(await requireArchive(id)));
  const session = selectSession(entries, flags.session);

  const localSessionId = flags.local ?? session.sessionId;
  const localFiles = readLocalSession(cwd, localSessionId);
  const info = await hub().getSession(id).catch(() => null);
  const remoteCwd = flags['remote-cwd'] ?? remoteWorkdir(session, info);
  if (!remoteCwd) {
    // The project folder alone cannot be decoded back into a path — every separator became the
    // same dash — so a session with a custom workdir has to be told what the pod's path is.
    process.stderr.write(
      `Warning: cannot tell which directory the pod worked in (project folder ${session.slug}).\n`
      + `The transcript keeps ${cwd} in its cwd fields. Pass --remote-cwd <path> to set it.\n`);
  }
  const plan = planPush(entries, localFiles, { session, remoteCwd });

  const archive = gzipSync(Buffer.from(writeTar(plan.entries)));
  await hub().uploadState(id, new Uint8Array(archive));

  if (flags.json) {
    return print(JSON.stringify(
      { sessionId: plan.sessionId, slug: plan.slug, bytes: archive.length }, null, 2));
  }
  print(`Uploaded ${archive.length} bytes of state to session ${id}.`);
  print('Resume the session in the hub; it continues from the transcript you just pushed.');
}

async function requireArchive(id) {
  const archive = await hub().downloadState(id);
  if (!archive) {
    throw new TransferError(
      `Session ${id} has no stored state. The hub stores it when a pod stops, so start the session `
      + 'once and pause it; a session that has never run has nothing to transfer.');
  }
  return Buffer.from(archive);
}

let cachedHub;
function hub() {
  if (!cachedHub) {
    const config = loadConfig();
    cachedHub = new Hub({ url: config.url, token: config.token });
  }
  return cachedHub;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const name = argument.slice(2);
    const [key, inline] = name.includes('=') ? [name.slice(0, name.indexOf('=')), name.slice(name.indexOf('=') + 1)] : [name, null];
    if (['force', 'json', 'help'].includes(key)) { flags[key] = true; continue; }
    flags[key] = inline ?? argv[++index];
    if (flags[key] === undefined) throw new TransferError(`--${key} needs a value.`);
  }
  return { command: positional.shift(), positional, flags };
}

function print(text) {
  process.stdout.write(`${text}\n`);
}

main(process.argv.slice(2)).catch(error => {
  const expected = error instanceof TransferError || error instanceof HubError;
  process.stderr.write(`${expected ? error.message : (error.stack ?? String(error))}\n`);
  process.exitCode = 1;
});
