# AgentHub Claude Code plugin

A Claude Code plugin marketplace for [Open AgentHub](https://github.com/open-agenthub/open-agenthub).
It currently holds one plugin, **agenthub-sessions**, which moves a single session between a hub
server and the machine you are sitting at.

## Why this exists at all

A hub session runs in a Kubernetes pod, and the session you are talking to lives in that pod's
`~/.claude`. Sometimes the pod is the wrong place to be: the network you need is only reachable from
your laptop, you want an IDE on the files, or you simply want to keep working on a plane.

The hub already stores what is needed. When a session pod stops, it uploads its agent home directory
as a `tar.gz`; when the session resumes, the next pod unpacks that archive back into place. This
plugin reaches the same archive through the hub's API, so going local is a download plus a path
rewrite, and coming back is an upload.

## Install

```bash
claude plugin marketplace add open-agenthub/agenthub-claude-plugin
claude plugin install agenthub-sessions@open-agenthub
```

Then point it at your hub, with a personal API token from **Settings → API tokens**:

```bash
export AGENTHUB_URL=https://agenthub.your-org.example
export AGENTHUB_TOKEN=oah_…
```

Or store them once, in `~/.agenthub/cli.json` with mode `600`:

```bash
node ~/.claude/plugins/…/agenthub-sessions/scripts/agenthub-session.mjs login \
  --url https://agenthub.your-org.example --token oah_…
```

Inside a Claude Code session you do not run the script yourself — ask for what you want
("continue hub session abc123 here", "push this back to the hub") and the `session-transfer`
skill handles it.

## Use it from the shell

```bash
agenthub-session list                 # sessions on the hub
agenthub-session pull <session-id>    # bring one into this directory
claude --resume <session-id>          # continue it
agenthub-session push <session-id>    # hand it back (pause the session in the hub first)
```

`agenthub-session` above is shorthand for
`node <plugin-dir>/scripts/agenthub-session.mjs`. Every command takes `--json`, and `--dir <path>`
selects a project directory other than the current one.

## What a transfer actually changes

Claude Code locates a session by the directory it was recorded in. The project folder name is the
working directory with every character outside `[A-Za-z0-9]` replaced by a dash
(`/workspace/repo` → `-workspace-repo`, `C:\Users\you\project` → `C--Users-you-project`), and every
line of the transcript repeats that working directory in a `cwd` field. A plain copy therefore
resumes nothing: the transcript sits in a folder belonging to a path that does not exist on the
other machine.

So a transfer rewrites exactly two things and nothing else:

- the **project folder**, to the one the target machine derives from its working directory
- the **`cwd` field** on each line that has one

A push additionally renames the transcript to the session id the hub stored, because that is the id
the pod passes to `claude --resume`. Everything else in the transcript is left byte-for-byte alone —
it is the agent's record of what happened, and an eager rewrite would be editing history.

## Limits worth knowing before you rely on it

- **The session must have run once.** The hub stores state when a pod stops, so a session that was
  never started has no archive to transfer.
- **A push needs the session paused.** A running pod writes its own state over the same key when it
  stops, which would silently undo the upload. The hub rejects the upload with a `409` instead.
- **Claude Code sessions only.** A Codex, Cursor or OpenClaw session stores a different home
  directory, and `claude --resume` has nothing to read in it.
- **One session at a time**, with its subagent transcripts. Project-level files such as
  `.claude/memory` are not carried across; they belong to the project on each machine, not to the
  session.
- **The repository should match.** The transcript refers to files by path. Pulling a session that
  worked on a repo you do not have checked out gives you the conversation, not the context.

## Hub version

Needs a hub with the session state endpoints, `GET` and `PUT` on
`api/remote/sessions/{id}/state`. Older servers answer `404` for the download, which the CLI
reports as the session having no stored state.

## Development

```bash
npm test
claude plugin validate ./plugins/agenthub-sessions
claude plugin validate .
```

No dependencies, and none should be added: a plugin is installed as plain files, so `npm install`
never runs for it, and a dependency that is missing at the moment of use is worse than the code it
would have saved. The tar reader and writer are checked against the real `tar` binary in both
directions, because GNU tar inside the pod is what produces and consumes these archives.
