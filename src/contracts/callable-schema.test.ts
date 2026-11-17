import { describe, expect, it } from "vitest";
import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA } from "./builtins.js";
import { validateCallableDefinition, type PineCallableDefinition } from "./callable-schema.js";

describe("production callable schema ownership", () => {
  it("validates every production overload, including names and optionality", () => {
    for (const [name, definition] of Object.entries(PINE_PRODUCTION_CALLABLE_METADATA)) {
      expect(() => validateCallableDefinition(name, definition), name).not.toThrow();
    }
  });
  it.each([
    ["box.set_text_color", ["id", "text_color"], ["id", "color"]],
    ["table.delete", ["table_id"], ["id"]],
    ["strategy.cancel", ["id"], ["id", "immediately"]],
  ] as const)("publishes the bound signature for %s while preserving the sealed overlay", (name, current, sealed) => {
    expect(PINE_PRODUCTION_CALLABLE_METADATA[name]!.parameters).toEqual(current);
    expect(PINE_CALLABLE_METADATA[name]!.parameters).toEqual(sealed);
  });
  it("rejects structural drift before a definition reaches consumers", () => {
    const base = PINE_PRODUCTION_CALLABLE_METADATA["str.repeat"]!;
    const invalid: PineCallableDefinition[] = [
      { ...base, signatureStatus: "unspecified" },
      { ...base, parameters: ["count", "source", "separator"] },
      { ...base, optionalParameters: ["missing"] },
      { ...base, optionalParameters: [] },
      { ...base, typedOverloads: [] },
      { ...base, variadicParameter: "extra" },
    ];
    for (const definition of invalid) expect(() => validateCallableDefinition("str.repeat", definition)).toThrow("Invalid callable");
  });
  it("freezes nested overloads and types without sharing profile schemas", () => {
    const definition = PINE_PRODUCTION_CALLABLE_METADATA["time"]!;
    expect(Object.isFrozen(definition.typedOverloads)).toBe(true);
    expect(Object.isFrozen(definition.typedOverloads![0]!.parameters[0]!.type)).toBe(true);
    expect(Object.isFrozen(definition.overloads![0])).toBe(true);
    expect(PINE_CALLABLE_METADATA["array.get"]!.typedOverloads).not.toBe(PINE_PRODUCTION_CALLABLE_METADATA["array.get"]!.typedOverloads);
  });
  it("publishes the production array.join default without widening the sealed signature", () => {
    expect(PINE_PRODUCTION_CALLABLE_METADATA["array.join"]!.optionalParameters).toEqual(["separator"]);
    expect(PINE_CALLABLE_METADATA["array.join"]!.optionalParameters).toBeUndefined();
  });
});
