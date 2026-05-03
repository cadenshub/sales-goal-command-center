import { mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

function currentCommit() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return `local-${Date.now()}`;
  }
}

const version = {
  buildId: currentCommit(),
  builtAt: new Date().toISOString(),
};

await mkdir("public", { recursive: true });
await writeFile("public/version.json", `${JSON.stringify(version, null, 2)}\n`);
