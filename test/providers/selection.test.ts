import { describe, expect, it } from "vitest";
import {
  parseCliChain,
  interactiveChainKinds,
} from "../../src/providers/selection.js";

describe("shared provider selection", () => {
  it("parses a raw chain string, trimming and dropping empties", () => {
    expect(parseCliChain(" codex , claude ,,antigravity ", {
      allowed: interactiveChainKinds(),
      fallback: ["codex"],
    })).toEqual(["codex", "claude", "antigravity"]);
  });

  it("filters entries not in the allowed set", () => {
    expect(parseCliChain("codex,not-a-cli,claude", {
      allowed: interactiveChainKinds(),
      fallback: ["codex"],
    })).toEqual(["codex", "claude"]);
  });

  it("falls back when the raw chain is unset or yields nothing", () => {
    expect(parseCliChain(undefined, { allowed: interactiveChainKinds(), fallback: ["codex", "claude"] }))
      .toEqual(["codex", "claude"]);
    expect(parseCliChain("bogus", { allowed: interactiveChainKinds(), fallback: ["claude"] }))
      .toEqual(["claude"]);
  });

  it("derives interactive kinds from the registry including kimchi", () => {
    expect(interactiveChainKinds()).toEqual(["codex", "claude", "antigravity", "kimchi"]);
  });

  it("derives the interactive chain from provider capabilities", () => {
    expect(interactiveChainKinds()).toEqual(["codex", "claude", "antigravity", "kimchi"]);
  });
});
