import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
const declarations = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const forbidden = ["node:", "process.", "require("];
const found = forbidden.filter((needle) => source.includes(needle));
if (found.length > 0) {
  console.error(`Browser bundle contains forbidden runtime references: ${found.join(", ")}`);
  process.exitCode = 1;
} else if (/@lumencharts\/script-/u.test(declarations)) {
  console.error("Browser bundle declarations contain unresolved workspace package references");
  process.exitCode = 1;
} else if (packageJson.dependencies !== undefined) {
  console.error("Browser bundle package must remain runtime dependency-free");
  process.exitCode = 1;
} else if (!source.includes("PineEngine = class")) {
  console.error("Browser bundle did not include the engine implementation");
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ browserSafe: true, bytes: Buffer.byteLength(source) }));
}
