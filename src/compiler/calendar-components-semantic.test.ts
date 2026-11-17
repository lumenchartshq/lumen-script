import { PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const components = ["year", "month", "weekofyear", "dayofmonth", "dayofweek", "hour", "minute", "second"] as const;

const compileCurrent = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("Calendar component semantics")\n${body}`,
});

describe("calendar component semantics", () => {
  it("publishes exact timestamp/timezone overloads and a series-int result", () => {
    for (const name of components) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[name]).toMatchObject({
        parameters: ["time", "timezone"],
        optionalParameters: ["timezone"],
        overloads: [["time"], ["time", "timezone"]],
        returnType: "series int",
        typedOverloads: [
          {
            parameters: [{ name: "time", type: { kind: "int", qualifier: "series" } }],
            returnType: { kind: "int", qualifier: "series" },
          },
          {
            parameters: [
              { name: "time", type: { kind: "int", qualifier: "series" } },
              { name: "timezone", type: { kind: "string", qualifier: "series" }, optional: true },
            ],
            returnType: { kind: "int", qualifier: "series" },
          },
        ],
      });
    }
  });

  it("binds variable, positional, default and reordered named forms as series ints", () => {
    const source = components.flatMap((name) => [
      `series int ${name}Variable = ${name}`,
      `series int ${name}Default = ${name}(time)`,
      `series int ${name}Positional = ${name}(time, "UTC+05:45")`,
      `series int ${name}Named = ${name}(timezone="America/New_York", time=time)`,
    ]).join("\n");
    const result = compileCurrent(source);

    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
    for (const name of components) {
      expect(result.program!.generatedSource).toContain(`"${name}"`);
    }
  });

  it("rejects timestamp/timezone kinds and stronger result qualifiers for every component", () => {
    for (const name of components) {
      const invalid = [
        [`${name}-timestamp-kind`, `value = ${name}(1.5)`, "SCRIPT2117", "requires series int"],
        [`${name}-timezone-kind`, `value = ${name}(time, 545)`, "SCRIPT2117", "requires series string"],
        [`${name}-call-qualifier`, `simple int value = ${name}(time)`, "SCRIPT2102", "Cannot assign series int"],
        [`${name}-variable-kind`, `series string value = ${name}`, "SCRIPT2102", "Cannot assign series int"],
        [`${name}-variable-qualifier`, `simple int value = ${name}`, "SCRIPT2102", "Cannot assign series int"],
      ] as const;
      for (const [id, source, code, message] of invalid) {
        const result = compileCurrent(source);
        expect(result.program, id).toBeUndefined();
        expect(result.diagnostics.find((diagnostic) => diagnostic.code === code)?.message, id).toContain(message);
      }
    }
  });

  it("keeps calendar calls absent from the sealed callable catalog", () => {
    const sealed = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6\nindicator("Sealed calendar")\nvalue = year(time)`,
    });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });
});
