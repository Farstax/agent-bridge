import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "..", "scripts", "arch-lint.sh");

function runLint(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT, dir], { encoding: "utf8" });
    return { code: 0, output };
  } catch (err: any) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * Runs arch-lint with its cwd set to `repoDir`, targeting `targetDir` (relative
 * to `repoDir`) — needed to exercise the migration-ownership rule's exact
 * repo-root-relative path matching (e.g. a fixture "src/db.ts") against a
 * fixture tree that isn't the real repo, since the rule computes paths
 * relative to process.cwd(), not the target-dir argument.
 */
function runLintInRepo(repoDir: string, targetDir: string): { code: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT, targetDir], { encoding: "utf8", cwd: repoDir });
    return { code: 0, output };
  } catch (err: any) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("arch-lint", () => {
  it("rejects durable CREATE TABLE statements outside migration owners", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-ddl-owner-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "feature.ts"), "export function install(db: any) { db.exec('CREATE TABLE foo_table (id INTEGER)'); }\n");
    const res = runLint(dir, "src");
    expect(res.code).toBe(1);
    expect(res.output).toContain("durable CREATE TABLE statements must live in a migration owner");
  });

  it("is executable", () => {
    accessSync(SCRIPT, constants.X_OK);
  });

  it("passes on a src tree without test-only APIs", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-clean-"));
    try {
      writeFileSync(join(dir, "ok.ts"), 'import { readFileSync } from "node:fs";\nexport const x = 1;\n');
      expect(runLint(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when src imports vitest", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-vitest-"));
    try {
      writeFileSync(join(dir, "bad.ts"), 'import { describe } from "vitest";\n');
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("arch-lint: test-only APIs must not be imported or called from src/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when src imports node:test", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-nodetest-"));
    try {
      writeFileSync(join(dir, "bad.ts"), 'import test from "node:test";\n');
      expect(runLint(dir).code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when src calls describe/it/test", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-calls-"));
    try {
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "nested", "bad.ts"), 'describe("x", () => {});\n');
      expect(runLint(dir).code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes on the real src/ tree", () => {
    expect(runLint(join(__dirname, "..", "..", "src")).code).toBe(0);
  });

  it("fails when a non-owner file queries an advisor/conversation table directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-owner-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        'export function f(db: any) {\n  return db.prepare(`SELECT * FROM conversation_turns WHERE chat_key = ?`).all("x");\n}\n',
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("advisor/conversation SQL must live in its owning repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when the SQL is preceded by an arch-lint-allow-legacy-sql marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-allowed-"));
    try {
      writeFileSync(
        join(dir, "ok.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: deliberate documented exception",
          "  return db.prepare(`SELECT * FROM conversation_turns WHERE chat_key = ?`).all(\"x\");",
          "}",
          "",
        ].join("\n"),
      );
      expect(runLint(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a marker exempt a nearby unmarked statement (no leakage)", () => {
    // Regression test: an earlier version of this check looked back a fixed
    // 15-line window for the marker, so a second, unmarked statement placed
    // shortly after a legitimately marked one would incorrectly pass. The
    // marker must bind to exactly the statement it sits directly above.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-leak-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function marked(db: any) {",
          "  // arch-lint-allow-legacy-sql: deliberate documented exception",
          "  return db.prepare(`SELECT * FROM conversation_turns WHERE chat_key = ?`).all(\"x\");",
          "}",
          "",
          "export function unmarked(db: any) {",
          "  return db.prepare(`SELECT * FROM conversation_summaries WHERE chat_key = ?`).all(\"x\");",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_summaries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not attribute a separately declared SQL string to an earlier marked statement (fails closed)", () => {
    // Regression test: a marker must prove the table reference is textually
    // inside its own .prepare()/.exec() call, not just "somewhere after a
    // marked statement and before the next one." A SQL string built in a
    // variable and passed to .prepare() later must not inherit an earlier
    // marked call's exemption — the reference here isn't inside any
    // .prepare()/.exec() call's own parentheses at all.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-separate-string-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: legitimate exception",
          "  db.prepare(`SELECT * FROM conversation_turns`).all();",
          "",
          "  const leakedSql = `SELECT * FROM conversation_summaries`;",
          "  return db.prepare(leakedSql).all();",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_summaries");
      expect(res.output).toContain("leakedSql");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a second unowned reference sharing a line with a marked statement", () => {
    // Regression test: the check must inspect every owned-table occurrence
    // on a line, not just the first (an earlier version used
    // line.search(), which only finds the first match). A marked statement
    // followed on the SAME line by an unrelated, unmarked SQL string
    // assignment must still be caught.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-same-line-string-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: legitimate exception",
          "  db.prepare(`SELECT * FROM conversation_turns`).all(); const leakedSql = `SELECT * FROM conversation_summaries`;",
          "  return db.prepare(leakedSql).all();",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_summaries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for two statements sharing a single marked line (ambiguous attribution)", () => {
    // Regression test: a marker precedes a LINE, not a specific call. If
    // two .prepare()/.exec() statements both start on that line, the
    // marker can't be unambiguously attributed to just one of them — both
    // must be treated as unmarked (fail closed) rather than both being
    // exempted.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-two-calls-one-line-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: legitimate exception",
          "  db.prepare(`SELECT * FROM conversation_turns`).all(); db.prepare(`SELECT * FROM conversation_summaries`).all();",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_turns");
      expect(res.output).toContain("conversation_summaries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a non-owner file queries an advisor_calls table directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-advisor-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        'export function f(db: any) {\n  return db.prepare(`SELECT * FROM advisor_calls WHERE request_id = ?`).get("x");\n}\n',
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("advisor/conversation SQL must live in its owning repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a comment-only mention of a conversation table name", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-comment-"));
    try {
      writeFileSync(
        join(dir, "ok.ts"),
        "// this note just mentions conversation_turns in prose, not SQL\nexport const x = 1;\n",
      );
      expect(runLint(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("migration-primitive ownership guard (Phase 4C.2, issue #135)", () => {
    const MSG = "must only be referenced from src/db.ts, src/db/schema.ts";

    it("passes when the five entrypoints import openProductionDb", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-entrypoints-ok-"));
      try {
        writeFileSync(
          join(dir, "index.ts"),
          'import { openProductionDb } from "./db.js";\nconst db = openProductionDb("/tmp/x.sqlite", {});\n',
        );
        expect(runLint(dir).code).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when a fixture entrypoint imports openDb directly", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-entrypoint-bad-"));
      try {
        writeFileSync(
          join(dir, "index.ts"),
          'import { openDb } from "./db.js";\nconst db = openDb("/tmp/x.sqlite");\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain(MSG);
        expect(res.output).toContain("openDb");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when a non-entrypoint src/ module imports openDb directly (deny-by-default, not a five-file allowlist)", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-nonentrypoint-"));
      try {
        writeFileSync(
          join(dir, "someHelper.ts"),
          'import { openDb } from "./db.js";\nexport function f() { return openDb(":memory:"); }\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("someHelper.ts");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when a fixture module imports applyMigrations, applyMigrationsUpTo, or applyLegacyCompatibleBaseline directly, with no openDb import at all", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-primitives-"));
      try {
        writeFileSync(
          join(dir, "bypass.ts"),
          [
            'import Database from "better-sqlite3";',
            'import { applyMigrations, applyMigrationsUpTo } from "./db/schema.js";',
            'import { applyLegacyCompatibleBaseline } from "./legacyBaselineMigration.js";',
            "export function bypass(raw: Database.Database) {",
            "  applyLegacyCompatibleBaseline(raw);",
            "  applyMigrationsUpTo(raw, [], 0);",
            "  applyMigrations(raw);",
            "}",
            "",
          ].join("\n"),
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("applyMigrations");
        expect(res.output).toContain("applyMigrationsUpTo");
        expect(res.output).toContain("applyLegacyCompatibleBaseline");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches an aliased named import (import { openDb as x })", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-alias-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          'import { openDb as x } from "./db.js";\nexport function f() { return x(":memory:"); }\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("openDb");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches namespace access (import * as db from \"./db.js\"; db.openDb(...))", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-namespace-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          'import * as db from "./db.js";\nexport function f() { return db.openDb(":memory:"); }\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("namespace import");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("denies a namespace import of a migration-owning module even if it never (visibly) touches a primitive — deny-by-default, not detect-then-allow", () => {
      // A property-access scan can be defeated by computed access
      // (db["openDb"]) or by destructuring off a dynamically-imported
      // module — an AST-free regex check cannot soundly prove a namespace
      // binding never reaches a primitive. So any namespace import of a
      // migration-owning module is unconditionally denied, regardless of
      // whether this particular file happens to only use it for a type.
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-namespace-ok-"));
      try {
        writeFileSync(
          join(dir, "fine.ts"),
          'import * as db from "./db.js";\nexport function f(x: db.BridgeDb) { return x; }\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("namespace import");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches computed property access off a namespace import (db[\"openDb\"])", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-computed-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          'import * as db from "./db.js";\nexport function f() { return db["openDb"](":memory:"); }\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("namespace import");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches a dynamic import() of a migration-owning module", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-dynamic-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          'export async function f() {\n  const { openDb } = await import("./db.js");\n  return openDb(":memory:");\n}\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("dynamic import");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches a named import hidden behind an interleaved comment (import { /* x */ openDb } from ...)", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-comment-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          'import { /* sneaky */ openDb } from "./db.js";\nexport function f() { return openDb(":memory:"); }\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("openDb");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches a dynamic import() whose specifier is a variable, not a string literal (regex-only checks matched only a literal quote/backtick right after \"import(\")", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-dynamic-var-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          [
            'const modulePath = "./db.js";',
            "export async function f() {",
            "  const { openDb } = await import(modulePath);",
            "  return openDb(\":memory:\");",
            "}",
            "",
          ].join("\n"),
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("dynamic import() with a non-literal specifier");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches a dynamic import() with a concatenated/template specifier", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-dynamic-template-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          'export async function f() {\n  const { openDb } = await import(`./${"db"}.js`);\n  return openDb(":memory:");\n}\n',
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("dynamic import() with a non-literal specifier");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not blank a real import when a string literal contains comment-delimiter-looking text (regex comment-stripping was not string-aware)", () => {
      // Regression for the exact bypass from review comment 5015149297: a
      // regex "strip anything between /* and */" pass would treat the `/*`
      // inside `const marker = "/*";` as the start of a comment, blanking
      // the real `import { openDb } from "./db.js";` statement below it
      // before the import-detection regex ever ran. A real parser knows the
      // `/*` is inside a string literal, not a comment token, so it can't be
      // fooled this way.
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-fake-comment-string-"));
      try {
        writeFileSync(
          join(dir, "sneaky.ts"),
          [
            'const marker = "/*";',
            'import { openDb } from "./db.js";',
            'const endMarker = "*/";',
            "export function f() { return openDb(\":memory:\"); }",
            "",
          ].join("\n"),
        );
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("openDb");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when src/db.ts imports a primitive outside its exact permitted set (applyMigrationsUpTo, not just applyMigrations)", () => {
      const repoDir = mkdtempSync(join(tmpdir(), "archlint-migown-db-overscope-"));
      try {
        mkdirSync(join(repoDir, "src", "db"), { recursive: true });
        writeFileSync(
          join(repoDir, "src", "db.ts"),
          'import { applyMigrations, applyMigrationsUpTo } from "./db/schema.js";\nexport function f() { applyMigrationsUpTo; return applyMigrations; }\n',
        );
        const res = runLintInRepo(repoDir, "src");
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("applyMigrationsUpTo");
        expect(res.output).not.toContain('"applyMigrations" from "./db/schema.js" is not');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("permits src/db.ts to import exactly applyMigrations, and src/db/schema.ts to import exactly applyLegacyCompatibleBaseline", () => {
      const repoDir = mkdtempSync(join(tmpdir(), "archlint-migown-db-inscope-"));
      try {
        mkdirSync(join(repoDir, "src", "db"), { recursive: true });
        writeFileSync(
          join(repoDir, "src", "db.ts"),
          'import { applyMigrations } from "./db/schema.js";\nexport function openDb() { applyMigrations; }\n',
        );
        writeFileSync(
          join(repoDir, "src", "db", "schema.ts"),
          'import { applyLegacyCompatibleBaseline } from "./legacyBaselineMigration.js";\nexport function applyMigrations() { applyLegacyCompatibleBaseline; }\nexport function applyMigrationsUpTo() {}\n',
        );
        writeFileSync(join(repoDir, "src", "db", "legacyBaselineMigration.ts"), "export function applyLegacyCompatibleBaseline() {}\n");
        expect(runLintInRepo(repoDir, "src").code).toBe(0);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("does not exempt a nested path that merely ends in /src/db.ts (exact-path ownership, not a suffix match)", () => {
      const repoDir = mkdtempSync(join(tmpdir(), "archlint-migown-nested-"));
      try {
        mkdirSync(join(repoDir, "vendor", "src"), { recursive: true });
        writeFileSync(
          join(repoDir, "vendor", "src", "db.ts"),
          'import { openDb } from "./db.js";\nexport function f() { return openDb(":memory:"); }\n',
        );
        const res = runLintInRepo(repoDir, "vendor/src");
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("openDb");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("catches a named re-export (export { openDb } from \"./db.js\")", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-reexport-"));
      try {
        writeFileSync(join(dir, "barrel.ts"), 'export { openDb } from "./db.js";\n');
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("openDb");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches a wildcard re-export (export * from \"./db.js\")", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-wildcard-"));
      try {
        writeFileSync(join(dir, "barrel.ts"), 'export * from "./db.js";\n');
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("wildcard");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("catches a wildcard namespace re-export (export * as db from \"./db.js\")", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-wildcard-ns-"));
      try {
        writeFileSync(join(dir, "barrel.ts"), 'export * as db from "./db.js";\n');
        const res = runLint(dir);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("wildcard");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not flag an unrelated named import from db.js (e.g. the BridgeDb type)", () => {
      const dir = mkdtempSync(join(tmpdir(), "archlint-migown-unrelated-"));
      try {
        writeFileSync(join(dir, "fine.ts"), 'import type { BridgeDb } from "./db.js";\nexport type X = BridgeDb;\n');
        expect(runLint(dir).code).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("passes on the real src/ tree", () => {
      expect(runLint(join(__dirname, "..", "..", "src")).code).toBe(0);
    });
  });
});
