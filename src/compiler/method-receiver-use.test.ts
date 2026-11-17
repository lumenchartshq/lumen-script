import { PINE_COMPATIBILITY, type PineVersion } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";

function run(body: string, caller = "plot(object.probe())", version: PineVersion = 6) {
  const source = `//@version=${String(version)}
indicator("Method receiver")
type Sample
    int n
method probe(Sample value, int unused = 0) =>
    ${body}
Sample object = Sample.new(11)
${caller}`;
  return compile({ source, compatibility: PINE_COMPATIBILITY.strict });
}

describe("method receiver use", () => {
  // FX:EURUSD captures and CE10236 diagnostics in language-method-receiver-usage.txt.
  it.each([
    ["a constant return", "11"],
    ["a discarded alias", "Sample alias = value\n    11"],
    ["a discarded check", "na(value)\n    11"],
    ["a literal-dead branch", "false ? value.n : 11"],
    ["a shadowed parameter", "if true\n        Sample value = Sample.new(11)\n        value.n\n    else\n        11"],
  ])("rejects a called method whose body contains %s", (_label, body) => {
    const result = run(body);
    expect(result.program).toBeUndefined();
    const diagnostic = result.diagnostics.find(({ code }) => code === "SCRIPT2140");
    expect(diagnostic?.message).toBe("The 'value' argument is not used. The first method argument should be used.");
    expect(diagnostic?.range?.start.line).toBe(5);
  });

  it("checks Pine v5 and a discarded call", () => {
    expect(run("11", "plot(object.probe())", 5).diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2140" }));
    expect(run("11", "object.probe()\nplot(close)").diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2140" }));
  });

  it("validates authored receivers even when a generated request drops their use", () => {
    const result = run('value.n + request.security("", "1", close)');
    expect(result.diagnostics).toEqual([]);
    const childSource = result.program?.requestPlans[0]?.program.source;
    if (childSource === undefined) throw new Error("Expected a generated request program");

    // Compiling the same text as authored Pine must apply receiver validation.
    const authored = compile({ source: childSource, compatibility: PINE_COMPATIBILITY.strict });
    expect(authored.program).toBeUndefined();
    expect(authored.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2140" }));
  });

  it.each([
    ["an uncalled method", "11", "plot(close)"],
    ["a literal-dead call", "11", "plot(false ? object.probe() : 11)"],
    ["a series branch", "bar_index < 0 ? value.n : 11", "plot(object.probe())"],
    ["a field mutation", "value.n := 12\n    11", "plot(object.probe())"],
    ["a direct call", "value.n", "plot(probe(object))"],
    ["a receiver-based return in a discarded call", 'log.info("independent")\n    value.n', "object.probe()\nplot(close)"],
  ])("compiles %s", (_label, body, caller) => {
    const result = run(body, caller);
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });
});
