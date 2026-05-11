# pi Model Markers Extension

A `pi` extension that keeps a record of which model and thinking level you
were using, inline in the chat.

By default pi only shows a transient "Switched to ..." notification at the
moment of the change. Once you `/resume` the session in a new chat or jump to
a different branch with `/tree`, that information is gone. This extension
turns each change into a small persistent marker that stays visible across
reloads and branch switches.

## What it looks like

```
󱙺 Active model: anthropic-vertex/claude-opus-4-7
󰧑 Thinking: high
```

```
󱙺 Switched to anthropic-vertex/claude-sonnet-4-5 (was anthropic-vertex/claude-opus-4-7)
```

The icons are Nerd Font glyphs (`U+F167A` robot, `U+F09D1` brain). With any
patched Nerd Font they render correctly. Otherwise you will see fallback
boxes; edit `index.ts` and swap them for whatever you like.

## Installation

Symlink (recommended, edits in the repo flow through to pi):

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD/model-markers" ~/.pi/agent/extensions/model-markers
```

Copy:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R model-markers ~/.pi/agent/extensions/model-markers
```

Then start pi, or run `/reload` if pi is already open. Quick test without
installing: `pi -e ./index.ts`.

## Notes

- Markers are persisted as `custom_message` entries, which means they do go
  into LLM context (one short line each). The cost is negligible, and the
  model knowing what settings are active is usually a feature.
- Rapid `Ctrl+P` cycling does not produce a marker per cycle. Only the model
  that the next prompt actually uses gets recorded.
- No configuration. Edit `index.ts` if you want different icons, wording, or
  behavior. The file is small and self-contained.
