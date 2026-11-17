import { PINE_BUILTIN_CATALOG, PINE_PRODUCTION_BUILTIN_CATALOG, pineCallableMetadata, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const compileCurrent = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nstrategy("Strategy core typing", initial_capital=1000)\n${body}`,
});

describe("strategy core semantic contracts", () => {
  it("types all six strict strategy.risk calls and leaves sealed signatures intact", () => {
    const calls = [
      ["allow_entry_in", "strategy.direction.long", "1"],
      ["max_cons_loss_days", '2, "loss days"', '"two"'],
      ["max_drawdown", '10, strategy.cash, "drawdown"', '"ten", strategy.cash'],
      ["max_intraday_filled_orders", '2, "fills"', '"two"'],
      ["max_intraday_loss", '5, strategy.percent_of_equity, "loss"', '"five", strategy.cash'],
      ["max_position_size", "2", '"two"'],
    ] as const;
    for (const [name, accepted, invalid] of calls) {
      const fullName = `strategy.risk.${name}`;
      const strict = pineCallableMetadata(PINE_COMPATIBILITY.strict)[fullName]!;
      expect(strict.typedOverloads?.[0]?.returnType.kind).toBe("void");
      expect(pineCallableMetadata(PINE_COMPATIBILITY.legacy)[fullName]!.typedOverloads?.[0]?.parameters[0]?.type.kind).toBe("unknown");
      for (const version of [5, 6]) {
        expect(compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${version}\nstrategy("Risk")\n${fullName}(${accepted})` }).diagnostics).toEqual([]);
      }
      for (const [body, code] of [
        [`${fullName}(${invalid})`, "SCRIPT2117"],
        [`${fullName}()`, "SCRIPT2014"],
        [`value = ${fullName}(${accepted})`, "SCRIPT2137"],
      ] as const) {
        expect(compileCurrent(body).diagnostics, body).toContainEqual(expect.objectContaining({ code }));
      }
    }
  });
  it("types the full production strategy.exit call without changing sealed binding", () => {
    const sealedDefinition = pineCallableMetadata(PINE_COMPATIBILITY.legacy)["strategy.exit"]!;
    const productionDefinition = pineCallableMetadata(PINE_COMPATIBILITY.strict)["strategy.exit"]!;
    expect(productionDefinition.parameters).toEqual(sealedDefinition.parameters);
    expect(productionDefinition.optionalParameters).toEqual(sealedDefinition.optionalParameters);
    expect(productionDefinition.parameters).toHaveLength(21);
    expect(sealedDefinition.typedOverloads?.[0]?.parameters[0]?.type.kind).toBe("unknown");
    expect(productionDefinition.typedOverloads?.[0]?.parameters.map(({ type }) => type.kind)).toEqual([
      "string", "string", "float", "float", "float", "float", "float", "float", "float", "float", "float",
      "string", "string", "string", "string", "string", "string", "string", "string", "string", "bool",
    ]);
    expect(productionDefinition.typedOverloads?.[0]?.returnType.kind).toBe("void");
    for (const version of [5, 6]) {
      for (const body of [
        'strategy.exit("X", "L", 1, 50, 2, 12, 2, 8, 11, 1, 2, "group", "base", "take", "stop", "trail", "alert", "a-take", "a-stop", "a-trail", true)',
        'strategy.exit(disable_alert=false, alert_trailing="t", alert_loss="l", alert_profit="p", alert_message="a", comment_trailing="t", comment_loss="l", comment_profit="p", comment="c", oca_name="g", trail_offset=2, trail_points=1, trail_price=11, stop=8, loss=2, limit=12, profit=2, qty_percent=50, qty=1, from_entry="L", id="X")',
        'strategy.exit("X", profit=1)',
      ]) {
        const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${version}\nstrategy("Exit")\n${body}` });
        expect(result.diagnostics, `${version}: ${body}`).toEqual([]);
        expect(result.program?.generatedSource).toContain('"strategy.exit"');
      }
    }
    for (const [body, code] of [
      ['strategy.exit()', "SCRIPT2014"],
      ['strategy.exit(1, limit=12)', "SCRIPT2117"],
      ['strategy.exit("X", from_entry=1, limit=12)', "SCRIPT2117"],
      ...["qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points", "trail_offset"].map((name) => [`strategy.exit("X", ${name}="wrong")`, "SCRIPT2117"]),
      ...["oca_name", "comment", "comment_profit", "comment_loss", "comment_trailing", "alert_message", "alert_profit", "alert_loss", "alert_trailing"].map((name) => [`strategy.exit("X", ${name}=1)`, "SCRIPT2117"]),
      ['strategy.exit("X", disable_alert=1)', "SCRIPT2117"],
      ['strategy.exit("X", id="X", limit=12)', "SCRIPT2014"],
      ['strategy.exit("X", unknown=1)', "SCRIPT2014"],
      [`strategy.exit("X", ${Array.from({ length: 21 }, () => "1").join(", ")})`, "SCRIPT2014"],
      ['value = strategy.exit("X", limit=12)', "SCRIPT2137"],
    ] as const) {
      const result = compileCurrent(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({ code }));
      expect(result.program, body).toBeUndefined();
    }
    expect(compile({ compatibility: PINE_COMPATIBILITY.legacy, source: '//@version=6\nstrategy("Sealed exit")\nstrategy.exit(1, 2, "three", limit="twelve")' }).diagnostics).toEqual([]);
  });

  it("types strict strategy.order arguments and its void result in v5 and v6", () => {
    const sealedDefinition = pineCallableMetadata(PINE_COMPATIBILITY.legacy)["strategy.order"]!;
    const productionDefinition = pineCallableMetadata(PINE_COMPATIBILITY.strict)["strategy.order"]!;
    expect(sealedDefinition.parameters).toEqual(productionDefinition.parameters);
    expect(sealedDefinition.optionalParameters).toEqual(productionDefinition.optionalParameters);
    expect(sealedDefinition.returnType).toBe("void");
    expect(sealedDefinition.typedOverloads?.[0]?.parameters[0]?.type.kind).toBe("unknown");
    expect(productionDefinition.typedOverloads?.[0]?.parameters[0]?.type.kind).toBe("string");
    expect(productionDefinition.typedOverloads?.[0]?.returnType.kind).toBe("void");
    for (const version of [5, 6]) {
      for (const body of [
        'strategy.order("L", strategy.long)',
        'strategy.order("S", strategy.short, 2, 9, 11, "group", strategy.oca.reduce, "note", "fill", true)',
        'strategy.order(disable_alert=false, alert_message="fill", comment="note", oca_type=strategy.oca.none, oca_name="group", stop=11, limit=9, qty=2, direction=strategy.long, id="L")',
      ]) {
        const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${version}\nstrategy("Order")\n${body}` });
        expect(result.diagnostics, `${version}: ${body}`).toEqual([]);
        expect(result.program?.generatedSource).toContain('"strategy.order"');
      }
    }
    for (const [body, code] of [
      ["strategy.order()", "SCRIPT2014"],
      ['strategy.order("L")', "SCRIPT2014"],
      ['strategy.order(1, strategy.long)', "SCRIPT2117"],
      ['strategy.order("L", 1)', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, qty="two")', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, limit="nine")', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, stop=true)', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, oca_name=1)', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, oca_type=1)', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, comment=1)', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, alert_message=1)', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, disable_alert=1)', "SCRIPT2117"],
      ['strategy.order("L", strategy.long, id="L")', "SCRIPT2014"],
      ['strategy.order("L", strategy.long, unknown=1)', "SCRIPT2014"],
      ['strategy.order("L", strategy.long, 1, 2, 3, "g", strategy.oca.none, "c", "a", false, 1)', "SCRIPT2014"],
      ['value = strategy.order("L", strategy.long)', "SCRIPT2137"],
    ] as const) {
      const result = compileCurrent(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({ code }));
      expect(result.program, body).toBeUndefined();
    }
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: '//@version=6\nstrategy("Sealed order")\nstrategy.order(1, 2, "three")' });
    expect(sealed.diagnostics).toEqual([]);
  });

  it("types strict close_all options and its void result without narrowing the sealed call", () => {
    for (const version of [5, 6]) {
      for (const body of [
        "strategy.close_all()",
        'strategy.close_all("exit", "filled", true, false)',
        'strategy.close_all(disable_alert=true, immediately=false, alert_message="filled", comment="exit")',
      ]) {
        const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${version}\nstrategy("Close all")\n${body}` });
        expect(result.diagnostics, `${version}: ${body}`).toEqual([]);
      }
    }

    for (const [body, code] of [
      ['strategy.close_all(1)', "SCRIPT2117"],
      ['strategy.close_all(alert_message=true)', "SCRIPT2117"],
      ['strategy.close_all(immediately="yes")', "SCRIPT2117"],
      ['strategy.close_all(disable_alert=1)', "SCRIPT2117"],
      ['strategy.close_all("x", comment="x")', "SCRIPT2014"],
      ['strategy.close_all(unknown=true)', "SCRIPT2014"],
      ['strategy.close_all("x", "y", true, false, 1)', "SCRIPT2014"],
      ['value = strategy.close_all()', "SCRIPT2137"],
    ] as const) {
      const result = compileCurrent(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({ code }));
      expect(result.program, body).toBeUndefined();
    }

    const sealed = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: '//@version=6\nstrategy("Sealed close all")\nstrategy.close_all(1, 2, 3, 4)',
    });
    expect(sealed.diagnostics).toEqual([]);
  });
  it("types the selected state variables and indexed trade accessors exactly", () => {
    const result = compileCurrent(`series float position = strategy.position_size
series int openCount = strategy.opentrades
series float openEntry = strategy.opentrades.entry_price(trade_num=0)
series float openSize = strategy.opentrades.size(0)
series int closedCount = strategy.closedtrades
series float closedEntry = strategy.closedtrades.entry_price(0)
series float closedExit = strategy.closedtrades.exit_price(trade_num=0)
series float closedProfit = strategy.closedtrades.profit(0)
plot(position + openCount + openEntry + openSize + closedCount + closedEntry + closedExit + closedProfit)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"strategy.opentrades.entry_price"');
    expect(result.program?.generatedSource).toContain('"strategy.closedtrades.profit"');
  });

  it("accepts supported positional and named strategy entry and close calls", () => {
    for (const body of [
      'strategy.entry("Long", strategy.long, 2)',
      'strategy.entry(direction=strategy.short, id="Short", qty=1, comment="named", disable_alert=false)',
      'strategy.close("Long", "partial", 1)',
      'strategy.close(id="Short", qty_percent=50, immediately=false, disable_alert=true)',
    ]) {
      expect(compileCurrent(body).diagnostics, body).toEqual([]);
    }
  });

  it("rejects missing or wrongly typed action and accessor arguments", () => {
    const invalid = [
      ["strategy.entry()", "SCRIPT2014"],
      ['strategy.entry("Long")', "SCRIPT2014"],
      ["strategy.entry(1, strategy.long)", "SCRIPT2117"],
      ['strategy.entry("Long", 1)', "SCRIPT2117"],
      ['strategy.entry("Long", strategy.long, qty="two")', "SCRIPT2117"],
      ["strategy.close()", "SCRIPT2014"],
      ["strategy.close(1)", "SCRIPT2117"],
      ['strategy.close("Long", qty="one")', "SCRIPT2117"],
      ['value = strategy.opentrades.entry_price("first")', "SCRIPT2117"],
      ["value = strategy.closedtrades.profit(0.5)", "SCRIPT2117"],
    ] as const;

    for (const [body, code] of invalid) {
      const result = compileCurrent(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({ code }));
      expect(result.program, body).toBeUndefined();
    }
  });

  it("rejects wrong result kinds, weaker qualifiers and void actions used as values", () => {
    const invalid = [
      "string invalid = strategy.position_size",
      "bool invalid = strategy.opentrades",
      "simple float invalid = strategy.position_size",
      "simple int invalid = strategy.closedtrades",
      "simple float invalid = strategy.opentrades.entry_price(0)",
      'value = strategy.entry("Long", strategy.long)',
      'value = strategy.close("Long")',
    ] as const;

    for (const body of invalid) {
      const result = compileCurrent(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({
        code: body.startsWith("value =") ? "SCRIPT2137" : "SCRIPT2102",
      }));
      expect(result.program, body).toBeUndefined();
    }
  });

  it("keeps selected accessors production-only and preserves sealed permissive typing", () => {
    expect(PINE_PRODUCTION_BUILTIN_CATALOG.builtins).toEqual(expect.arrayContaining([
      "strategy.opentrades.entry_price",
      "strategy.opentrades.size",
      "strategy.closedtrades.entry_price",
      "strategy.closedtrades.exit_price",
      "strategy.closedtrades.profit",
    ]));
    expect(PINE_BUILTIN_CATALOG.builtins).not.toContain("strategy.opentrades.entry_price");

    const sealed = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
strategy("Sealed strategy typing")
string permissive = strategy.position_size
strategy.entry(1, strategy.long)`,
    });
    expect(sealed.diagnostics).toEqual([]);
  });
});
