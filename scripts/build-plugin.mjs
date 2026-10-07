import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["src/magpie/plugin.ts"],
  outfile: "magpie-plugin/dist/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["es2023"],
  legalComments: "none",
  treeShaking: true,
});
await copyFile("LICENSE", "magpie-plugin/LICENSE");
await copyFile("node_modules/zod/LICENSE", "magpie-plugin/THIRD_PARTY_LICENSES.txt");
