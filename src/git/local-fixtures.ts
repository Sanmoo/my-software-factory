import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const execFile = promisify(execFileCallback);

/**
 * Local git fixtures for the git host tests: a seed working repo whose bare
 * clone plays the remote — no GitHub, no network. The bare remote lives
 * under <root>/remotas/<owner>#<name>.git, the seed under
 * <root>/semente/<owner>#<name>.
 */

export interface FixtureRemote {
  /** Path of the bare remote for one repo (the clone URL in tests). */
  barePath(repo: string): string;
  /** The seed working repo — commit here and push to advance the remote. */
  seedDir: string;
  /** Commit a file on a branch of the seed and push it to the bare remote. */
  commitFile(branch: string, file: string, content: string, message: string): Promise<void>;
}

/** Commit a file in any working repo (seed or clone) on its current branch. */
export async function commitFileIn(
  dir: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(dir, file), content, "utf8");
  await execFile("git", ["add", file], { cwd: dir });
  await execFile("git", ["commit", "-q", "--allow-empty", "-m", message], { cwd: dir });
}

/**
 * Seed a repo with one commit on the default branch and publish it to a
 * bare remote — the fixture every test points its clone URL at.
 */
export async function seedFixtureRemote(
  root: string,
  repo: string,
  options: { defaultBranch: string },
): Promise<FixtureRemote> {
  const git = async (args: string[], cwd?: string) =>
    execFile("git", args, { cwd: cwd ?? join(root, "semente", repo) });

  const seedDir = join(root, "semente", repo);
  const bare = join(root, "remotas", `${repo.replaceAll("/", "#")}.git`);
  mkdirSync(seedDir, { recursive: true });

  await git(["init", "-q", "-b", options.defaultBranch, seedDir]);
  await git(["init", "-q", "--bare", "-b", options.defaultBranch, bare]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "fixture"]);
  await git(["remote", "add", "origin", bare]);
  await commitFileIn(seedDir, "file.txt", "v1\n", "seed commit");
  await git(["push", "-q", "-u", "origin", options.defaultBranch]);

  return {
    barePath: () => bare,
    seedDir,
    async commitFile(branch, file, content, message) {
      await git(["checkout", "-q", branch]);
      await commitFileIn(seedDir, file, content, message);
      await git(["push", "-q", "origin", branch]);
    },
  };
}

/** The fixtures live entirely under the test's temp root — one rmSync cleans them. */
export function cleanupFixture(root: string): void {
  rmSync(join(root, "semente"), { recursive: true, force: true });
  rmSync(join(root, "remotas"), { recursive: true, force: true });
}
