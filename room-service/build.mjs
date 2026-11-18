import { copyFileSync, mkdirSync } from "node:fs";

const output = new URL("dist/server/", import.meta.url);
mkdirSync(output, { recursive: true });
copyFileSync(new URL("worker.mjs", import.meta.url), new URL("index.js", output));
