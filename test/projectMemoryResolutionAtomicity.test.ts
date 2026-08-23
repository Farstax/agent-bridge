import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { storeProjectMemoryCandidate } from "../src/projectMemory.js";

beforeEach(() => {
  process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED = "true";
});

afterEach(() => {
  delete process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED;
});

describe("project memory resolution atomicity", () => {
  it("rolls back the resolver insert and earlier resolutions when a later resolution fails", () => {
    const db = openDb(":memory:");
    try {
      db.addMemory({
        id: "mem_blocker_1",
        type: "todo",
        scope: "project",
        text: "First stale blocker that should remain unresolved after rollback.",
      });
      db.addMemory({
        id: "mem_blocker_2",
        type: "todo",
        scope: "project",
        text: "Second stale blocker that forces the transactional rollback.",
      });
      db.raw.exec(`
        CREATE TRIGGER fail_second_memory_resolution
        BEFORE UPDATE OF resolved_by ON project_memories
        WHEN OLD.id = 'mem_blocker_2'
        BEGIN
          SELECT RAISE(ABORT, 'forced resolution failure');
        END;
      `);

      const resolverText = "Verified replacement decision resolves both stale project blockers.";
      expect(() => storeProjectMemoryCandidate(
        db,
        {
          type: "decision",
          scope: "project",
          text: resolverText,
          resolves: ["mem_blocker_1", "mem_blocker_2"],
        },
        { chatKey: "chat:atomic", cliKind: "codex", repoPath: "/repo" },
      )).toThrow(/forced resolution failure/);

      expect(db.raw.prepare("SELECT id FROM project_memories WHERE text = ?").get(resolverText)).toBeUndefined();
      expect(db.raw.prepare(
        "SELECT id, resolved_by FROM project_memories WHERE id IN (?, ?) ORDER BY id",
      ).all("mem_blocker_1", "mem_blocker_2")).toEqual([
        { id: "mem_blocker_1", resolved_by: null },
        { id: "mem_blocker_2", resolved_by: null },
      ]);
    } finally {
      db.close();
    }
  });
});
