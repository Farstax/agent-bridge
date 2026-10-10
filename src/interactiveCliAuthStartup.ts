import { prepareInteractiveCliAuthStartup } from "./interactiveCliAuth.js";

// Side-effect module for interactive entrypoints: establish env + API-key
// evidence before the first synchronous routing decision.
if (process.env.NODE_ENV !== "test") {
  await prepareInteractiveCliAuthStartup();
}
