#!/usr/bin/env bun

import path from "node:path"

const out = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "src/index.ts")],
  target: "bun",
  format: "esm",
  minify: false,
  external: ["@opencode-ai/plugin"],
})

if (!out.success) {
  console.error("Bundle failed:")
  for (const msg of out.logs) console.error(msg)
  process.exit(1)
}

const artifact = out.outputs[0]
if (!artifact) {
  console.error("Bundle produced no output")
  process.exit(1)
}

const result = await artifact.text()
const dest = path.join(import.meta.dir, "dist", "config-d.js")

await Bun.write(dest, result)
console.log(`Bundled to ${dest} (${(result.length / 1024).toFixed(1)} KB)`)
