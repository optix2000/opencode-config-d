import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigDPlugin } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CONFIG_D_TEST_VALUE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("deep-merges sorted config.d fragments into the active config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode/config-d-"));
  tempDirs.push(root);
  const globalDir = path.join(root, "opencode");
  const configD = path.join(globalDir, "config.d");
  await fs.mkdir(configD, { recursive: true });
  await fs.writeFile(path.join(globalDir, "opencode.jsonc"), "{}\n");
  await fs.writeFile(path.join(configD, "10-base.jsonc"), '{ "permission": { "bash": { "*": "ask" } } }');
  await fs.writeFile(path.join(configD, "20-overlay.json"), '{ "permission": { "bash": { "git *": "allow" } } }');

  process.env.XDG_CONFIG_HOME = root;
  const hooks = await ConfigDPlugin({} as any);
  const config: Record<string, unknown> = { permission: { edit: "deny" } };

  await hooks.config?.(config as any);

  expect(config).toEqual({
    permission: {
      edit: "deny",
      bash: {
        "*": "ask",
        "git *": "allow",
      },
    },
  });
});

test("expands env and file placeholders in config fragments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode/config-d-"));
  tempDirs.push(root);
  const globalDir = path.join(root, "opencode");
  const configD = path.join(globalDir, "config.d");
  await fs.mkdir(configD, { recursive: true });
  await fs.writeFile(path.join(globalDir, "opencode.json"), "{}\n");
  await fs.writeFile(path.join(configD, "secret.txt"), "from-file\n");
  await fs.writeFile(
    path.join(configD, "10-placeholders.jsonc"),
    '{ "provider": { "test": { "options": { "apiKey": "{env:CONFIG_D_TEST_VALUE}", "token": "{file:secret.txt}" } } } }',
  );

  process.env.XDG_CONFIG_HOME = root;
  process.env.CONFIG_D_TEST_VALUE = "from-env";
  const hooks = await ConfigDPlugin({} as any);
  const config = {};

  await hooks.config?.(config as any);

  expect(config).toEqual({
    provider: {
      test: {
        options: {
          apiKey: "from-env",
          token: "from-file",
        },
      },
    },
  });
});
