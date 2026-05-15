# opencode-config-d

An [opencode](https://opencode.ai) plugin that overlays global config fragments from `config.d`.

## Behavior

The plugin reads the global opencode config directory from `XDG_CONFIG_HOME/opencode` or `~/.config/opencode`, then:

- Loads `opencode.json` or `opencode.jsonc` as the base existence check.
- Reads `config.d/*.json` and `config.d/*.jsonc` in sorted order.
- Deep-merges plain objects into the live opencode config.
- Replaces `{env:NAME}` with environment variables.
- Replaces `{file:path}` with trimmed file contents, resolving relative paths against the fragment file.

## Install

With `opencode-plugin-manager`:

```jsonc
{
  "plugins": [
    {
      "source": "git",
      "repo": "https://github.com/optix2000/opencode-config-d.git"
    }
  ]
}
```

For local bundled install:

```sh
bun install
bun run bundle
cp dist/config-d.js ~/.config/opencode/plugins/config-d.js
```

Restart opencode after changing plugin registrations.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun run bundle
```
