import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { FileSnapshotter, GitSnapshotter } from "../src/session/snapshot.ts";
import { tempDir } from "./helpers/context.ts";

describe("git snapshots", () => {
  it("restores content, modes, symlinks, deletions and new directories exactly", { skip: process.platform === "win32" }, async () => {
    const root = await tempDir("usta-snap-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    await fs.writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await fs.writeFile(path.join(root, "keep.txt"), "keep\n");
    await fs.symlink("run.sh", path.join(root, "link"));
    await fs.writeFile(path.join(root, "space name.txt"), "with space\n");
    const snap = new GitSnapshotter(root, await tempDir("usta-snapdata-"));
    const id = await snap.track();

    await fs.writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho changed\n");
    await fs.chmod(path.join(root, "run.sh"), 0o644);
    await fs.rm(path.join(root, "link"));
    await fs.writeFile(path.join(root, "link"), "now a regular file\n");
    await fs.rm(path.join(root, "keep.txt"));
    await fs.writeFile(path.join(root, "space name.txt"), "edited\n");
    await fs.mkdir(path.join(root, "gen", "deep"), { recursive: true });
    await fs.writeFile(path.join(root, "gen", "deep", "out.txt"), "generated\n");

    const changes = await snap.changes(id);
    assert.deepEqual(changes.map((c) => `${c.status} ${c.path}`).sort(), [
      "added gen/deep/out.txt",
      "deleted keep.txt",
      "modified link",
      "modified run.sh",
      "modified space name.txt",
    ]);
    await snap.restore(id);

    assert.equal(await fs.readFile(path.join(root, "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
    assert.equal((await fs.stat(path.join(root, "run.sh"))).mode & 0o111, 0o111);
    assert.ok((await fs.lstat(path.join(root, "link"))).isSymbolicLink());
    assert.equal(await fs.readlink(path.join(root, "link")), "run.sh");
    assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "keep\n");
    assert.equal(await fs.readFile(path.join(root, "space name.txt"), "utf8"), "with space\n");
    await assert.rejects(fs.stat(path.join(root, "gen")));
    assert.deepEqual(await snap.changes(id), []);
  });
});

describe("file snapshots", () => {
  it("restores files the tools touched", async () => {
    const root = await tempDir("usta-fsnap-");
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "one\n");
    const snap = new FileSnapshotter(root);
    const id = await snap.track();
    await snap.beforeWrite(file);
    await fs.writeFile(file, "two\n");
    const created = path.join(root, "b.txt");
    await snap.beforeWrite(created);
    await fs.writeFile(created, "new\n");
    assert.deepEqual((await snap.changes(id)).map((c) => `${c.status} ${c.path}`).sort(), ["added b.txt", "modified a.txt"]);
    await snap.restore(id);
    assert.equal(await fs.readFile(file, "utf8"), "one\n");
    await assert.rejects(fs.stat(created));
  });
});
