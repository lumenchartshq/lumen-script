import { describe, expect, it } from "vitest";
import { PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("Table D4")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });
const table = "table panel = table.new(position.top_right, 2, 2)\n";

const assigned = [
  "cell", "cell_set_bgcolor", "cell_set_height", "cell_set_text", "cell_set_text_color",
  "cell_set_text_font_family", "cell_set_text_halign", "cell_set_text_size", "cell_set_text_valign",
  "cell_set_tooltip", "cell_set_width", "clear", "delete", "merge_cells", "new", "set_bgcolor",
  "set_border_color", "set_border_width", "set_frame_color", "set_frame_width", "set_position",
] as const;

describe("D4 strict table semantic contract", () => {
  it("has exact production receiver, coordinate and result types for all 21 calls", () => {
    for (const method of assigned) {
      const metadata = PINE_PRODUCTION_CALLABLE_METADATA[`table.${method}`];
      expect(metadata, method).toBeDefined();
      expect(metadata?.typedOverloads, method).toHaveLength(method === "cell" || method === "cell_set_text_size" ? 2 : 1);
      expect(metadata?.typedOverloads?.[0]?.returnType.kind, method).toBe(method === "new" ? "reference" : "void");
      const receiver = metadata?.typedOverloads?.[0]?.parameters[0];
      if (method !== "new") expect(receiver?.type, method).toEqual({ kind: "reference", name: "table", qualifier: "series" });
      for (const parameter of metadata?.typedOverloads?.[0]?.parameters ?? []) {
        expect(parameter.type.kind, `${method}.${parameter.name}`).not.toBe("unknown");
        if (["column", "row", "start_column", "start_row", "end_column", "end_row"].includes(parameter.name)) {
          expect(parameter.type.kind, `${method}.${parameter.name}`).toBe("int");
        }
      }
    }
  });

  it("accepts every assigned call in namespace and method forms plus typed table.all", () => {
    const result = strict(`${table}table alias = panel
table.cell(alias, 0, 0, "A", width=20, height=10, text_color=color.white, text_halign=text.align_left, text_valign=text.align_top, text_size=size.small, bgcolor=color.blue, tooltip="Tip", text_font_family=font.family_monospace)
panel.cell(1, 0, "B")
table.cell_set_bgcolor(panel, 0, 0, color.red)
panel.cell_set_height(0, 0, 12)
table.cell_set_text(panel, 0, 0, "Updated")
panel.cell_set_text_color(0, 0, color.green)
table.cell_set_text_font_family(panel, 0, 0, font.family_default)
panel.cell_set_text_halign(0, 0, text.align_right)
table.cell_set_text_size(panel, 0, 0, size.large)
panel.cell_set_text_valign(0, 0, text.align_bottom)
table.cell_set_tooltip(panel, 0, 0, "Changed")
panel.cell_set_width(0, 0, 25)
table.merge_cells(panel, 0, 1, 1, 1)
panel.clear(0, 1, 1, 1)
table.set_bgcolor(panel, color.black)
panel.set_border_color(color.white)
table.set_border_width(panel, 2)
panel.set_frame_color(color.gray)
table.set_frame_width(panel, 1)
panel.set_position(position.bottom_left)
array<table> live = table.all
int count = live.size()
table.delete(panel)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("admits named size strings and nonnegative integer pixel sizes on both size forms", () => {
    const result = strict(`${table}table.cell(panel, 0, 0, "A", text_size=size.small)
panel.cell(1, 0, "B", text_size=25)
table.cell_set_text_size(panel, 0, 0, size.auto)
panel.cell_set_text_size(1, 0, 0)
table.cell_set_text_size(panel, 0, 0, 36)`);
    expect(result.diagnostics).toEqual([]);
    for (const name of ["table.cell", "table.cell_set_text_size"] as const) {
      const overloads = PINE_PRODUCTION_CALLABLE_METADATA[name]?.typedOverloads ?? [];
      expect(overloads.map(({ parameters }) => parameters.find(({ name }) => name === "text_size")?.type.kind)).toEqual(["string", "int"]);
    }
  });

  it("rejects wrong size domains in namespace, named and method syntax", () => {
    const values = ["true", "color.red", "panel", "matrix.new<int>(1, 1, 2)", "12.5", '"unsupported"', "-1"];
    for (const value of values) {
      for (const call of [
        `table.cell(panel, 0, 0, "A", text_size=${value})`,
        `panel.cell(0, 0, "A", text_size=${value})`,
        `table.cell_set_text_size(panel, 0, 0, ${value})`,
        `panel.cell_set_text_size(0, 0, ${value})`,
      ]) {
        const result = strict(table + call);
        expect(result.program, call).toBeUndefined();
        expect(result.diagnostics.some(({ message }) => message.includes("text_size")), call).toBe(true);
      }
    }
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source(table + "table.cell_set_text_size(panel, 0, 0, true)") });
    expect(sealed.program).toBeDefined();
  });

  it("rejects wrong receivers, coordinates, option domains, value types and void assignments", () => {
    const negatives = [
      ["table.new(position.top_right, 1.5, 2)", "columns"],
      ["table.new(\"invalid\", 2, 2)", "Invalid table position"],
      [table + "table.cell(1, 0, 0, \"x\")", "table_id"],
      [table + "table.cell(panel, 0.5, 0, \"x\")", "column"],
      [table + "table.cell_set_text_font_family(panel, 0, 0, 1)", "text_font_family"],
      [table + "table.set_bgcolor(panel, 7)", "bgcolor"],
      [table + "x = panel.cell_set_text(0, 0, \"x\")", "Void expression"],
      [table + "string value = table.all", "Cannot assign"],
    ] as const;
    for (const [body, message] of negatives) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message)), body).toBe(true);
    }
    expect(compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source("table.new(\"top_right\", 1, 1)") }).program).toBeDefined();
  });
});
