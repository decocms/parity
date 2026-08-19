import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const target = "dist/cli.js";
const shebang = "#!/usr/bin/env node\n";

const current = readFileSync(target, "utf8");
if (!current.startsWith("#!")) {
  writeFileSync(target, shebang + current);
}
chmodSync(target, 0o755);

console.log(`postbuild: shebang + chmod +x on ${target}`);
