---
name: session-transfer
description: Continue an Open AgentHub session on this machine, or hand a locally continued session back to the hub. Use when the user wants to pull down, take over, continue locally, resume on their laptop, push back, or upload an AgentHub session, or asks which hub sessions can be transferred.
---

# Transfer an AgentHub session

An Open AgentHub server already stores every session's state: when a session pod stops it uploads
the agent's home directory, and a resume unpacks that archive into the next pod. This skill reaches
the same archive, so continuing a session here is a download plus a path rewrite, and handing it
back is an upload.

The CLI needs `node` on the PATH and nothing else.

## Before anything else

Check that the hub is configured. It reads `AGENTHUB_URL` and `AGENTHUB_TOKEN` from the
environment, or `~/.agenthub/cli.json`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agenthub-session.mjs" list
```

If that reports it is not configured, ask the user for their hub URL and a personal API token
(**Settings → API tokens** in the hub, a value starting with `oah_`), then store them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agenthub-session.mjs" login --url <url> --token <token>
```

Never echo the token back into the conversation, and do not pass it on a command line other than
this one.

## Continue a hub session here

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agenthub-session.mjs" pull <session-id>
```

The transcript lands in this directory's project folder, and the command prints the
`claude --resume <id>` line that continues it. Tell the user to run that line themselves in a new
Claude Code session — you cannot resume into your own session from inside it.

What to know:

- **The session needs a stored archive**, which it has once it has run. A session that was never
  started has nothing to transfer.
- **The working directory matters.** Claude Code finds a session by the directory it was recorded
  in, so run the pull from the directory the user wants to work in, or pass `--dir <path>`. The
  repository checked out in the pod and the local one should be the same project, otherwise the
  transcript refers to files that are not there.
- **An existing local transcript with other content is not overwritten.** The command fails and
  says so; only pass `--force` after the user confirms losing that local work.

## Hand a session back to the hub

The session must be **paused** in the hub first — a running pod writes its own state over the
upload when it stops. Pause it in the web app, or have the user do it, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agenthub-session.mjs" push <session-id>
```

This takes the transcript recorded for the current directory and makes it the session's stored
state, keeping the rest of the pod's home directory. Resuming the session in the hub then continues
from the local conversation.

If the local transcript was not pulled from that session, say which local transcript is being used
and confirm with the user first — the push replaces what the hub has stored:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agenthub-session.mjs" local
```

## When something goes wrong

| What you see | What it means |
| --- | --- |
| `Not configured` | No URL/token; run `login` as above |
| `rejected the token (401)` | The token is wrong or revoked; a hub token starts with `oah_` |
| `is still running` | Pause the session in the hub, then push again |
| `has no stored state` | The session never ran; start and pause it once |
| `holds no transcript` | The session runs an agent other than Claude Code, so there is nothing `claude --resume` could read |
| `more than one transcript` | The session worked in several directories; pass `--session <id>` with one of the listed ids |
| `cannot tell which directory the pod worked in` | The session has a custom workdir. Ask the user for it and pass `--remote-cwd <path>` |

Every command also takes `--json` when you need to read the result rather than show it.
