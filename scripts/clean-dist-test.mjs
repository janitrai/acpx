import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const distTestDir = path.join(projectRoot, "dist-test");

await fs.rm(distTestDir, { recursive: true, force: true });
