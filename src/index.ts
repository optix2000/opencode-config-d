import type { Plugin } from "@opencode-ai/plugin";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

type ConfigLike = Record<string, any>;

const CONFIG_EXTENSIONS = new Set([".json", ".jsonc"]);

export const ConfigDPlugin: Plugin = async () => {
  function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function mergeDeep(target: any, source: any): any {
    if (!isPlainObject(target) || !isPlainObject(source)) {
      return Array.isArray(source) ? source.slice() : source;
    }
    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value) && isPlainObject(target[key])) {
        target[key] = mergeDeep(target[key], value);
      } else {
        target[key] = Array.isArray(value) ? value.slice() : value;
      }
    }
    return target;
  }

  async function readText(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function loadConfigFile(filePath: string): Promise<ConfigLike | null> {
    const text = await readText(filePath);
    if (text == null) return null;
    return loadConfigText(text, filePath);
  }

  async function loadConfigText(text: string, filePath: string): Promise<ConfigLike> {
    let working = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || "";
    });

    const fileMatches = working.match(/\{file:[^}]+\}/g);
    if (fileMatches) {
      const configDir = path.dirname(filePath);
      const lines = working.split("\n");
      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match));
        if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) {
          continue;
        }
        let fileRef = match.replace(/^\{file:/, "").replace(/\}$/, "");
        if (fileRef.startsWith("~/")) {
          fileRef = path.join(os.homedir(), fileRef.slice(2));
        } else if (fileRef === "~") {
          fileRef = os.homedir();
        }
        const resolved = path.isAbsolute(fileRef)
          ? fileRef
          : path.resolve(configDir, fileRef);
        const fileContent = await fs
          .readFile(resolved, "utf8")
          .then((content) => content.trim())
          .catch((error: any) => {
            if (error?.code === "ENOENT") {
              throw new Error(
                `config-d: bad file reference "${match}" (${resolved} does not exist) in ${filePath}`,
              );
            }
            throw new Error(`config-d: bad file reference "${match}" in ${filePath}`);
          });
        working = working.replace(match, JSON.stringify(fileContent).slice(1, -1));
      }
    }

    const errors: any[] = [];
    const parsed = parseJsonc(working, errors, { allowTrailingComma: true });
    if (errors.length) {
      const lines = working.split("\n");
      const message = errors
        .map((err) => {
          const before = working.substring(0, err.offset).split("\n");
          const line = before.length;
          const column = before[before.length - 1].length + 1;
          const problem = lines[line - 1] ?? "";
          return `${printParseErrorCode(err.error)} at line ${line}, column ${column}\n   Line ${line}: ${problem}`;
        })
        .join("\n");
      throw new Error(`config-d: failed to parse ${filePath}\n${message}`);
    }

    if (!isPlainObject(parsed)) return {};
    return parsed as ConfigLike;
  }

  async function loadGlobalConfig(dir: string): Promise<ConfigLike | null> {
    const jsonPath = path.join(dir, "opencode.json");
    const json = await loadConfigFile(jsonPath);
    if (json) return json;
    return await loadConfigFile(path.join(dir, "opencode.jsonc"));
  }

  async function loadConfigD(dir: string): Promise<ConfigLike> {
    const configDir = path.join(dir, "config.d");
    let entries: Dirent[];
    try {
      entries = await fs.readdir(configDir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return {};
      throw new Error(`config-d: failed to read ${configDir}`);
    }

    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => CONFIG_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort()
      .map((name) => path.join(configDir, name));

    let result: ConfigLike = {};
    for (const file of files) {
      const parsed = await loadConfigFile(file);
      if (parsed && isPlainObject(parsed)) {
        result = mergeDeep(result, parsed);
      }
    }
    return result;
  }

  return {
    config: async (config) => {
      const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
      const globalDir = xdgConfig
        ? path.join(xdgConfig, "opencode")
        : path.join(os.homedir(), ".config", "opencode");
      const base = await loadGlobalConfig(globalDir);
      if (!base) return;

      const overlay = await loadConfigD(globalDir);
      if (!isPlainObject(overlay) || Object.keys(overlay).length === 0) return;

      mergeDeep(config as ConfigLike, overlay);
    },
  };
};

export default ConfigDPlugin;
