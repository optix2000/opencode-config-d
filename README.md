# opencode-config-d

Native [OpenCode V2](https://opencode.ai/v2/docs/build/plugins) plugin for global `config.d` defaults. Targets **OpenCode 2.0.32**, with the stable plugin ID `opencode-config-d`. This release does not implement the V1 plugin API.

## Install

Use OpenCode's native package loader; a separate plugin manager is not required:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["git+https://github.com/optix2000/opencode-config-d.git"]
}
```

The equivalent Git shorthand is `github:optix2000/opencode-config-d`. Append `#<full-commit-sha>` to pin a revision. Once published to npm, `opencode-config-d@<version>` is also a supported package specification. Select one source, not multiple copies of the same plugin.

Alternatively, configure a local checkout with `"plugins": ["./plugins/opencode-config-d"]`. The package exports its TypeScript source; the optional bundle is not required for Git installs. Dependencies are declared in `package.json` and `package-lock.json`.

## Fragments

The plugin loads regular `*.json` and `*.jsonc` files from `$XDG_CONFIG_HOME/opencode/config.d`, falling back to `~/.config/opencode/config.d`. Extensions are case-insensitive. No separate global `opencode.json(c)` base file is required. Files are sorted lexically by filename; later files override earlier ones. Objects merge deeply, arrays replace, and a changed MCP `type` replaces the complete union member.

```jsonc
// config.d/10-explore.jsonc
{
  "agents": {
    "explore": {
      "model": "openai/gpt-6.1-sol#high-encrypted",
      "permissions": [{ "action": "ast", "resource": "*", "effect": "allow" }]
    }
  }
}
```

```jsonc
// config.d/20-services.jsonc
{
  "providers": {
    "local": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8000/v1", "apiKey": "{env:LOCAL_API_KEY}" },
      "models": {
        "reasoner": {
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "variants": [
            { "id": "high", "settings": { "reasoningEffort": "high" }, "body": { "include": ["reasoning.encrypted_content"] } }
          ]
        }
      }
    }
  },
  "mcp": {
    "servers": {
      "docs": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "headers": { "Authorization": "Bearer {file:../secrets/docs-token}" }
      }
    }
  }
}
```

JSONC comments and trailing commas are accepted. Substitutions operate on parsed **string values**, not JSON syntax or keys:

- `{env:NAME}` inserts the environment value; missing variables become an empty string.
- `{file:path}` inserts trimmed file contents. Relative paths resolve from the fragment's directory; absolute paths and `~/` are supported.
- Quotes, backslashes and newlines remain literal credential data, never executable JSON. Inserted values are not recursively expanded. Placeholders in comments are ignored. Parse/schema/reference errors do not print resolved values.

Supported local V1 fragments also work: `agent`, `provider`, legacy MCP maps, provider `npm`/`api`/`options`, model `id`/`tool_call`/`modalities`, legacy cache costs and variant maps. AI SDK package names are converted to `aisdk:` specifications; OpenAI-compatible custom model options become request `body` fields. Prefer native fields for new fragments.

## Project precedence and safety

The plugin registers synchronous `agent`, `provider`, `model`, and `mcp` transforms after loading its files once. It reconstructs explicit project declarations separately, rather than guessing provenance by comparing current values with fragment values. A project declaration wins even when its value equals a fragment's value. Explicit empty objects protect their subtree.

Discovery follows released V2 ordering: `OPENCODE_CONFIG`, direct ancestor `opencode.json(c)` files from filesystem root to the active directory, ancestor `.opencode` configs and agent Markdown definitions, then `OPENCODE_CONFIG_CONTENT`. It honors `OPENCODE_DISABLE_PROJECT_CONFIG` and excludes the global config directory. Native Markdown `model`, `request`, `disabled`, `permissions`, and the body-as-`system` are preserved; legacy agent/mode files remain supported.

- Ordered project tool permissions are replayed **after** fragment agent permissions. Rules from earlier project documents are retained, not accidentally replaced by later permission arrays; top-level rules precede agent-specific rules, as in native configuration. A fragment allow cannot erase an applicable project deny.
- Ordered provider/integration policies support native `policies`, legacy `experimental.policies`, and V1 provider filters. Broader project policy sources outrank narrower ones, with last-match-wins wildcard rules within each document. OpenCode remains responsible for enforcing global/system/Console policies.
- Disabled native provider sources, models, agents and MCP servers are not re-enabled. A project-disabled MCP declaration without a V1 `type` is also respected. Project MCP type changes never mix local and remote fields.

## Deliberate V2 limits

V2 has **no global config hook**. Fragments therefore accept only `agents`, `providers`, `mcp.servers`, the supported local V1 aliases, and optional `$schema` metadata. Unsupported roots fail startup rather than silently doing nothing. In particular, put top-level `model`, `permissions`, `policies`, `plugins`, commands, skills and other general settings in native `opencode.json(c)`. Use agent-specific permissions in fragments. `mcp.timeout` defaults and enabled-only fragment MCP declarations are unsupported; provide a complete server configuration.

- **New agents cannot be created through the public agent editor.** Fragments may customize already-loaded built-in, project or other-plugin agents; unknown IDs fail clearly. Declare custom agents in native config or `.opencode/agents/` first. Plugin order matters for agents supplied by another plugin.
- Native model `capabilities.reasoning` requires OpenCode's internal variant-lowering adapter, not exposed by the public model editor. Use explicit `variants` in fragments, or configure reasoning capabilities in native `providers`. Unsupported fragment lowering fails explicitly.
- `Provider.Info` has no `env` metadata field. Fragment-only providers are explicit enabled sources; use substituted `settings.apiKey` for credentials. For native environment-driven activation, declare the provider and its `env` list in native config instead. Existing native provider activation is retained.
- Public plugin context exposes no full config-source list. Non-environment CLI/SDK config injections and virtual sources cannot be reconstructed. Native global config has no public value provenance either: fragment values replace unprotected native global values. Global/system/Console policy enforcement is still the host's responsibility.
- There is no file watcher. Restart the service after editing fragments: `opencode service restart`. Transform replay is side-effect-free, and registrations are disposed when the plugin unloads.

For isolated use, the native plugin object configuration accepts an optional `options.globalDirectory` pointing to a directory containing `config.d`:

```jsonc
{
  "plugins": [{ "package": "./plugins/opencode-config-d", "options": { "globalDirectory": "./isolated-opencode" } }]
}
```

Relative `globalDirectory` options resolve from the service's working directory; use an absolute directory for an isolated integration test.

## Development

```sh
npm install
bun test
npm run typecheck
bun run bundle
```

`@opencode/plugin` and `@opencode/schema` are pinned peer/development dependencies at `2.0.32`; Effect is pinned at the matching host runtime `4.0.1`. The bundle externalizes `@opencode/*` and `effect` (including subpaths) to avoid embedding duplicate host schemas/runtime state. `jsonc-parser` and `yaml` are regular runtime dependencies.

Tests use native public schema constructors and replayable mock domain editors, not V1 hooks. They cover source precedence, native/legacy agent frontmatter, substitutions, ordered permissions/policies, disabled entities, transform replay, cleanup, and unsupported-domain failures. They do not connect real providers/MCP servers or mutate a live OpenCode service.
