import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderHtmlReport } from "../src/report/render.ts";
import { Run } from "../src/types/schema.ts";

const runDir = resolve(process.argv[2]!);
const json = JSON.parse(readFileSync(`${runDir}/report.json`, "utf8"));
const run = Run.parse(json);
const html = renderHtmlReport(run, runDir);
writeFileSync(`${runDir}/report.html`, html);
console.log(`re-rendered: ${runDir}/report.html`);
