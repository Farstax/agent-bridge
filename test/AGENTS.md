# Regression test durability

A bug fix earns the smallest durable regression that protects the current invariant—not a permanent museum of how the bug was found or fixed.

- Protect current executable invariants, not implementation history.
- Give each invariant one authoritative test owner.
- Fold temporary red, repro, characterization, and review-fix tests into the canonical domain suite before merge, then delete the temporary file.
- Delete tests with deleted mechanisms. Do not keep tombstones for historical absence.
- Do not test wording in human-facing Markdown, Skills, Souls, or instruction files. Test only machine-consumed syntax, metadata, frontmatter, generated shape, installable assets, and workflow contracts.
- Prefer observable behavior over source shape. If a current static architecture boundary needs enforcement, give it one architecture-lint owner.
- Reuse generic capability coverage instead of issue- or review-named copies.
- Avoid Cartesian test matrices unless each dimension changes behavior.
- Test topology should shrink when runtime topology shrinks.
- Historical absence is not a regression by default. Retain only a narrower current architecture invariant when justified.
- Review every new regression for maintenance value as well as failure detection.
