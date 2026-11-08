// Build the native bundle: tsc emits the Host ESM tree, esbuild bundles the
// Client half into the Harness module-loader envelope.
//
// The toolchain is resolved from this checkout's node_modules, then a DSH
// checkout's node_modules when the package is built without installing here.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_ID = "gitfeed-native";
const typecheckOnly = process.argv.includes("--typecheck-only");

function resolveBin(name) {
  const candidates = [
    path.join(ROOT, "node_modules", ".bin", name),
    path.join(process.env.DSH_CHECKOUT || path.join(os.homedir(), "deepseek-harness"), "node_modules", ".bin", name)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("build: cannot find " + name + " (run `pnpm install` here, or set DSH_CHECKOUT)");
}

function run(bin, args) {
  execFileSync(bin, args, { cwd: ROOT, stdio: "inherit" });
}

const tsc = resolveBin("tsc");
const esbuild = resolveBin("esbuild");

if (!typecheckOnly) {
  rmSync(path.join(ROOT, "lib"), { recursive: true, force: true });
  mkdirSync(path.join(ROOT, "lib"), { recursive: true });
}

run(tsc, ["-p", "tsconfig.host.json"]);
run(tsc, ["-p", "tsconfig.client.json"]);

if (typecheckOnly) {
  console.log("typecheck ok");
  process.exit(0);
}

const bundle = path.join(ROOT, "lib", "client.bundle.cjs");
run(esbuild, [
  "src/client/main.ts",
  "--bundle",
  "--format=cjs",
  "--platform=browser",
  "--target=es2022",
  "--external:react",
  "--outfile=" + bundle,
  "--log-level=warning"
]);

const code = readFileSync(bundle, "utf8");
const wrapped = `window.__ModuleLoader__.load({
  id: '${BUNDLE_ID}',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
${code}
    return module.exports && module.exports.__esModule && module.exports.default
      ? module.exports.default
      : module.exports;
  }
});
`;
writeFileSync(path.join(ROOT, "lib", "client.js"), wrapped);
rmSync(bundle, { force: true });
console.log("built lib/index.js and lib/client.js");
