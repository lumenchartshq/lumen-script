import { describe, expect, it } from "vitest";
import { isScriptCode, normalizeScriptCode } from "./diagnostic-codes.js";

describe("Lumen Script diagnostic aliases", () => {
  it("normalizes old named and numbered diagnostics", () => {
    expect(normalizeScriptCode("PINE_RUNTIME_ERROR")).toBe("SCRIPT_RUNTIME_ERROR");
    expect(normalizeScriptCode("PINE2117")).toBe("SCRIPT2117");
    expect(normalizeScriptCode("SCRIPT2117")).toBe("SCRIPT2117");
    expect(isScriptCode("PINE2117", "SCRIPT2117")).toBe(true);
    expect(isScriptCode("SCRIPT_RUNTIME_ERROR", "PINE_RUNTIME_ERROR")).toBe(true);
  });

  it("keeps unrelated and malformed identifiers intact", () => {
    expect(normalizeScriptCode("RATE_LIMITED")).toBe("RATE_LIMITED");
    expect(normalizeScriptCode("PINE2117 extra")).toBe("PINE2117 extra");
    expect(isScriptCode("PINE2117", "SCRIPT2118")).toBe(false);
    expect(isScriptCode(null, "SCRIPT2117")).toBe(false);
  });
});
