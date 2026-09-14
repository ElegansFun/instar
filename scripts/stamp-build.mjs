// Writes site/build.json: the commit this deploy is built from, whether the
// tree had uncommitted changes, and when. The world serves it on /api/config
// so the site can say which source it is running and link the commit. A
// dirty tree is stamped as dirty, never as clean.
//   node scripts/stamp-build.mjs        (npm run stamp; deploy:railway runs it first)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const stamp = { commit, dirty, at: new Date().toISOString() };
fs.writeFileSync(path.join(root, "site", "build.json"), JSON.stringify(stamp) + "\n");
console.log(`stamped ${commit.slice(0, 10)}${dirty ? " (dirty)" : ""}`);
