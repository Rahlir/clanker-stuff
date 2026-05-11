# Coexisting with pi-chat

`pi-chat` (https://github.com/earendil-works/pi-chat) calls
`pi.setActiveTools([...])` on `session_start` with a hardcoded allowlist
(`read`, `write`, `edit`, `bash`, `chat_history`, `chat_attach`,
`chat_request_secret`, `chat_workers`). This **silently disables** every
custom tool not in that list, including this `code_review` extension and any
other extension-registered tools (`questionnaire`, etc.). Until pi-chat is
fixed upstream to merge with the existing active tools instead of replacing
them, the fix below disables `pi-chat` by default and re-enables it on demand
via a shell alias. `pi-chat` itself re-passes `-e` flags to its spawned tmux
workers (see `explicitExtensionCommandParts()` in `pi-chat/index.ts`), so
chat conversations still work end to end.

> Tested against `pi` 0.73.1 and the pi-chat repository at
> `https://github.com/earendil-works/pi-chat` (`index.ts` entry point).

## Steps

### 1. Disable pi-chat in `~/.pi/agent/settings.json`

In the `packages` array, find the pi-chat entry (likely the plain string
`"https://github.com/earendil-works/pi-chat"`) and convert it to the object
form with a force-exclude pattern:

```json
{
  "source": "https://github.com/earendil-works/pi-chat",
  "extensions": ["-index.ts"]
}
```

`-index.ts` force-excludes the extension entry point relative to the package
root (see `docs/packages.md` in `@mariozechner/pi-coding-agent`). The package
stays cloned and `pi update` still updates it.

Match the exact `source` string already in `settings.json` (npm, git ref,
fork, etc.) instead of hardcoding the URL above.

### 2. Add a shell alias

Append to the user's shell aliases file (`~/.bash_aliases`, `~/.bashrc`,
`~/.zshrc`, ...). Match whatever guard style the file already uses.

```bash
if command -v pi &> /dev/null; then
    alias pi-chat='pi -e ~/.pi/agent/git/github.com/earendil-works/pi-chat/index.ts'
fi
```

Verify the path with
`ls ~/.pi/agent/git/github.com/earendil-works/pi-chat/index.ts` first. If
pi-chat was installed from npm or a local path, point `-e` at that location
instead.

Then `source` the file (or open a new shell).

## Verification

From a directory with no project-local pi-chat extension:

1. `pi -p "List every available tool."` -> includes `code_review`, no
   `chat_*` tools.
2. `pi-chat -p "List every available tool."` -> includes the four `chat_*`
   tools, no `code_review`.
3. (Optional) start a chat via `pi-chat`, then `tmux ls` and inspect the
   worker command line. It should contain `-e <pi-chat path>`.

If any check fails, report what was observed instead of silently working
around it.
