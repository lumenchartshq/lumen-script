import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const header = '//@version=6\nindicator("D7 casts")\n';
const families = ["box", "label", "line", "linefill", "table"] as const;

describe("D7 drawing casts", () => {
  it.each(families)("binds %s(na), same-family references and named value", (family) => {
    const source = `${header}${family} missing = ${family}(na)\n${family} alias = ${family}(value=missing)`;
    const result = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(result.diagnostics, source).toEqual([]);
    expect(result.program?.generatedSource).toContain(`"${family}"`);
  });

  it.each(families)("rejects wrong-family and scalar arguments to %s", (family) => {
    for (const value of ["42", "true", '"wrong"', "line(na)"]) {
      if (family === "line" && value === "line(na)") continue;
      const source = `${header}${family} wrong = ${family}(${value})`;
      const result = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
      expect(result.program, source).toBeUndefined();
      expect(result.diagnostics.some(({ code }) => code === "SCRIPT2117"), source).toBe(true);
    }
  });

  it("keeps the sealed cast admission unchanged", () => {
    const result = compile({ source: `${header}line old = line(42)`, compatibility: PINE_COMPATIBILITY.legacy });
    expect(result.diagnostics).toEqual([]);
  });
});
