import { expect, it } from "vitest";

it("fails only to prove that failed qualification blocks merge", () => {
  expect("failed qualification").toBe("successful qualification");
});
