import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/ui", { recursive: true });
await build({ entryPoints: ["src/ui/admin.js"], outfile: "dist/ui/admin.js",
  bundle: true, minify: true, format: "esm", target: ["es2022"], legalComments: "none" });
for (const file of ["index.html", "admin.css"]) await copyFile(`src/ui/${file}`, `dist/ui/${file}`);
