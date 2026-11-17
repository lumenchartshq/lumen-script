<h1 align="center">Lumen Script</h1>

<p align="center">
  <strong>A Pine Script® v5 and v6 engine for JavaScript</strong><br>
  Compile indicators and strategies, run them bar by bar over your own OHLC
  data, and read plots, drawings, alerts and backtest results as plain objects.
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-AGPL--3.0--only%20%2F%20commercial-blue.svg?style=flat-square" alt="License: AGPL-3.0-only or commercial"></a>
  <a href="https://docs.lumencharts.com/charting-library/studies/lumen-script"><img src="https://img.shields.io/badge/docs-lumencharts-4f46e5.svg?style=flat-square" alt="Documentation"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> •
  <a href="#features">Features</a> •
  <a href="#usage">Usage</a> •
  <a href="#api-coverage">API coverage</a> •
  <a href="#documentation">Docs</a> •
  <a href="#use-with-ai-agents">AI agents</a> •
  <a href="#license">License</a>
</p>

## What is Lumen Script?

Lumen Script is the script engine behind [Lumen Charts](https://lumencharts.com).
It compiles Pine Script® v5 and v6 indicators and strategies, runs them bar by
bar against OHLC data, and returns plots, drawings, alerts and strategy
results. It also checks library scripts. It runs in the browser with no
runtime dependencies and knows nothing about charts: the host supplies bars
and draws the results.

The engine has two halves. `compile` turns source into a program, or into
diagnostics with line and column ranges. A `PineEngine` session then executes
that program with Pine's series model: history references, `var` state,
bar states, `request.security` contexts and the strategy broker emulator. A
session keeps its state, so new and updated bars cost one bar of work, not a
rerun.

```ts
import { PINE_COMPATIBILITY, PineEngine, compile } from "@lumencharts/script";

const { program, diagnostics } = compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6
indicator("EMA cross", overlay=true)
plot(ta.ema(close, 9), "Fast")
plot(ta.ema(close, 21), "Slow")`,
});
if (!program) throw new Error(diagnostics.map((item) => item.message).join("\n"));

const session = new PineEngine().createSession(program, { timeframe: "60" });
const { plots } = await session.runBatch(bars); // your OHLC bars, oldest first
console.log(plots.map((plot) => [plot.title, plot.points.at(-1)?.value]));
```

The Pine Script® trademark notice is in the [License](#license) section.

## Why Lumen Script?

Pine Script® is written for a chart. Lumen Script lets the same source run
anywhere JavaScript runs, with the chart left to you.

| You need | Lumen Script gives you |
| --- | --- |
| Indicators in your own product, not someone else's | An engine you embed: browser, Web Worker, Node.js 20 or later |
| Values you can feed to code | Plot series, drawings, tables, alerts and logs as typed objects |
| Backtests you can inspect | A strategy report with every order, trade and the equity timeline |
| Real-time updates without rerunning history | Sessions that append bars, replace the developing bar, and checkpoint |
| Errors your editor can underline | Structured diagnostics with a code, a message and a source range |
| Results you can reproduce later | Dated compatibility profiles and an engine identity in each checkpoint |

## Quick start

### Install

```bash
npm install @lumencharts/script
```

The package is ESM only and ships TypeScript declarations. It has no runtime
dependencies and makes no network requests of its own: data reaches the engine
only through the bars and callbacks you pass in.

### Hello world

```ts
import { PINE_COMPATIBILITY, PineEngine, compile, type MarketBar } from "@lumencharts/script";

const bars: MarketBar[] = [
  { openTime: 0, closeTime: 3_600_000, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
  { openTime: 3_600_000, closeTime: 7_200_000, open: 10.5, high: 12, low: 10, close: 11.8, volume: 140 },
  { openTime: 7_200_000, closeTime: 10_800_000, open: 11.8, high: 12.4, low: 11.1, close: 11.3, volume: 90 },
  // ...one entry per bar, oldest first, times in UTC milliseconds
];

const result = compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6
indicator("Fast average")
plot(ta.sma(close, 3), "SMA 3")`,
});
if (!result.program) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));

const session = new PineEngine().createSession(result.program, { timeframe: "60" });
const output = await session.runBatch(bars);
for (const point of output.plots[0].points) console.log(new Date(point.time).toISOString(), point.value);
await session.close();
```

Each plot is `{ id, title, options, points }`, and each point is
`{ time, value, options }`. Pine's `na` is `NaN`, so a 20-bar average has
`NaN` on its first 19 points.

A session keeps its state between calls: `appendBars` adds new bars,
`replaceTail` updates the last bar in real time, and `checkpoint` and `restore`
save and resume a session. `PINE_COMPATIBILITY.strict` is the dated production
profile; `PINE_COMPATIBILITY.legacy` is the baseline profile, kept so recorded
results stay reproducible.

## Features

- **Pine Script® v6 and v5**: `//@version=6` and `//@version=5` sources, with
  v5 semantics kept where they differ.
- **Indicators and strategies**: `indicator()` and `strategy()` programs, with
  inputs, plots, fills, shapes, bar and background colours.
- **Drawings and tables**: `line`, `box`, `label`, `linefill`, `polyline` and
  `table`, returned as a scene, and as added, updated and deleted sets on
  incremental runs.
- **Strategy backtests**: market, limit, stop and stop-limit orders, exits with
  profit, loss and trailing stops, OCA groups, pyramiding, commission,
  slippage and margin, with a report that includes Sharpe and Sortino ratios.
- **Alerts and logs**: `alert()` and `alertcondition()` events, and `log.*`
  messages in a bounded, paged journal.
- **Other symbols and timeframes**: `request.security` and its relatives load
  data through a gateway you implement.
- **Incremental sessions**: append bars, replace the developing bar, update
  inputs, page through long histories and report progress.
- **Checkpoints**: JSON-safe snapshots that restore a session in another
  process or worker.
- **Limits and cancellation**: bar and per-bar operation budgets, table cell
  caps and an `AbortSignal`.
- **Strict content security policies**: an optional precompiled mode that
  never calls `Function` at run time.
- **Typed built-in catalog**: every built-in name, signature and category,
  for editors, linters and autocompletion.

## Usage

### Compile and report errors

`compile` never throws for a bad script. It returns diagnostics instead, each
with a severity, a stable code, a message and, where it applies, a source
range:

```ts
const result = compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6
indicator("Broken")
plot(ta.sma(close, "20"))`,
});

for (const item of result.diagnostics) {
  const at = item.range ? `${item.range.start.line}:${item.range.start.column}` : "-";
  console.log(`${item.severity} ${item.code} at ${at}: ${item.message}`);
}
// error SCRIPT2117 at 3:20: Argument 'length' for 'ta.sma' requires series int, received const string
```

Match on `code`, not on the message text. A successful compile also returns
`descriptor`: the declaration's title, overlay, scale and precision, and its
inputs, plots and alerts, so a host can build a settings form before the first
bar runs.

### Run a script over history

```ts
const session = new PineEngine().createSession(program, {
  timeframe: "60", // the bars' timeframe, as Pine spells it: "1", "60", "1D", "1W"
  timezone: "America/New_York",
  symbolInfo: { ticker: "ACME", tickerid: "NASDAQ:ACME", currency: "USD", mintick: 0.01 },
  inputs: { length: 20 }, // by input ID, as listed in program.descriptor.inputs
});
const result = await session.runBatch(bars);
```

`runBatch` evaluates every bar from the start and replaces any earlier state.
The result holds:

| Field | Contents |
| --- | --- |
| `plots` | One entry per plot, with per-point colour and style options |
| `drawings` | The live lines, boxes, labels, linefills and polylines |
| `tables` | Table snapshots with cells, merges and colours |
| `alerts` | `alert()` and `alertcondition()` events with bar index and time |
| `strategy` | The strategy report, for `strategy()` scripts |
| `returned` | Every script variable's series, unless you narrow it with `resultVariables` |
| `diagnostics`, `stats` | Run-time warnings, bars processed and elapsed time |

### Update in real time

Feed closed bars with `appendBars` and the developing bar with `replaceTail`.
Both return a delta: the full result plus `fromIndex`, the first bar that
changed, and `sceneDelta`, the drawings and tables that were added, updated or
deleted.

```ts
const delta = await session.appendBars([nextBar]);
redraw(delta.fromIndex, delta.plots, delta.sceneDelta);

// The last bar is still forming: replace it on every tick.
const tick = await session.replaceTail([{ ...nextBar, high: 12.6, close: 12.5 }]);
redraw(tick.fromIndex, tick.plots, tick.sceneDelta);
```

`replaceTail` rolls the last bar back and evaluates it again, so `var` state
and drawings behave as they do on a live chart. The session decides which bars
are real-time with its `now` option, which defaults to `Date.now`.

### Save and resume a session

```ts
const saved = JSON.stringify(session.checkpoint());
await session.close();

// Later, in another worker or process:
const resumed = new PineEngine().createSession(program, { timeframe: "60" });
const result = await resumed.restore(JSON.parse(saved));
await resumed.appendBars([nextBar]);
```

A checkpoint records the bars, the inputs, the runtime state and the engine
and program identities. Restoring it into a different program or engine
version fails rather than producing different numbers.

### Backtest a strategy

```ts
const { program } = compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6
strategy("SMA cross", overlay=true, initial_capital=10000)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")`,
});

const session = new PineEngine().createSession(program!, { timeframe: "60", symbolInfo: { currency: "USD", mintick: 0.01 } });
const { strategy } = await session.runBatch(bars);
if (strategy) {
  console.log(strategy.netProfit, strategy.closedTrades, strategy.winningTrades, strategy.maxDrawdown);
  for (const trade of strategy.closedTradeRecords) console.log(trade.entryTime, trade.exitTime, trade.profit);
}
```

The report also carries every order, open trades, gross profit and loss,
run-up, buy-and-hold comparison, CAGR, the Sharpe and Sortino ratios, and a
per-bar `timeline` of position and equity.

### Change inputs

```ts
await session.updateInputs({ length: 50 });
const rerun = await session.runBatch(bars);
```

Input IDs and their types, defaults, bounds and options are in
`program.descriptor.inputs`. A value of the wrong type or outside the bounds
is rejected.

### Read other symbols and timeframes

`request.security` and the other `request.*` functions that need market data
ask your gateway for it. The compiler plans every request ahead of time, so
the engine knows which series it needs before the first bar:

```ts
import type { MarketDataGateway } from "@lumencharts/script";

const marketDataGateway: MarketDataGateway = {
  async load({ symbol, timeframe, calcBarsCount }, signal) {
    const response = await fetch(`/api/bars?symbol=${symbol}&tf=${timeframe}`, { signal });
    return { bars: await response.json() };
  },
};

const session = new PineEngine().createSession(program, {
  timeframe: "60",
  symbolInfo: { tickerid: "NASDAQ:ACME" },
  marketDataGateway,
});
```

`request.security_lower_tf` uses the same gateway. Strategies that fill orders
inside a bar take lower-timeframe bars up front through `intrabarBars`, keyed
by the parent bar's open time. Volume-footprint requests use a separate
`footprintGateway`.

### Long histories and progress

```ts
for await (const page of session.runPaginated(bars, 5_000)) {
  render(page.fromIndex, page.plots);
}

await session.runBatch(bars, {
  onProgress: ({ processedBars, totalBars }) => setProgress(processedBars / totalBars),
});
```

### Limits and cancellation

```ts
const controller = new AbortController();
const session = new PineEngine().createSession(program, {
  signal: controller.signal,
  limits: { maxBars: 20_000, maxOperationsPerBar: 100_000, maxTableCells: 2_000 },
});
```

A run that exceeds a limit or is aborted rejects, and the session can be closed
or run again. For untrusted scripts, run the engine in a Web Worker or a
separate process as well, so a slow script cannot block your page.

### Strict content security policies

By default a session instantiates the compiled program with `Function`. If your
page forbids that (no `'unsafe-eval'` in `script-src`), emit the executor as a
module at build time and load it as ordinary code:

```ts
import { writeFile } from "node:fs/promises";
import { emitExecutorModule } from "@lumencharts/script";

await writeFile("indicator.executor.js", emitExecutorModule(program)); // build step
```

```ts
import executor from "./indicator.executor.js"; // in the page

const session = new PineEngine().createSession(program, {
  codeGeneration: "precompiled",
  executorFactory: () => executor,
});
```

### Compatibility profiles

Every compile names a profile. Behaviour within a profile does not change, so
recorded results stay reproducible:

| Profile | Value | Use it for |
| --- | --- | --- |
| `PINE_COMPATIBILITY.strict` | `production-2026-08` | New work. The dated production behaviour. |
| `PINE_COMPATIBILITY.legacy` | `baseline-2026-08` | Reproducing results recorded against the baseline. |

`PINE_RUNTIME_IDENTITY` reports the engine version and profile, for logs and
caches.

### Libraries

`compile` runs `indicator()` and `strategy()` programs. A `library()` script is
checked rather than executed: `validatePineLibraryExports` reports problems
with its exported functions and types, and `validatePineLibraryRequestPolicy`
checks the `request.*` calls it makes. Resolving `import` statements is up to
the host, which supplies the library sources it trusts. The source helpers
`pineGlobalBindings`, `renamePineBindings`, `renamePineReceiverMethods` and
`stripPineLibraryDemonstration` help a host link a checked library into the
script that imports it: list a library's top-level names, rename them so they
can't collide, and drop the library's own demonstration code.

## API surface

| Export | Purpose |
| --- | --- |
| `compile(request)` | Source to `CompiledProgram`, `descriptor` and `diagnostics` |
| `PineEngine`, `EngineSession` | Sessions: `runBatch`, `appendBars`, `replaceTail`, `runPaginated`, `updateInputs`, `checkpoint`, `restore`, `logs`, `close` |
| `PINE_COMPATIBILITY`, `isStrictPineCompatibility` | Compatibility profiles |
| `emitExecutorModule` | Precompiled executors for strict content security policies |
| `PineRuntimeError` | Errors raised by scripts at run time, such as `runtime.error()` |
| `pineBuiltinCatalog`, `pineBuiltinRegistry`, `pineCallableMetadata` | Built-in names, categories and signatures for a profile |
| `PINE_PRODUCTION_BUILTIN_CATALOG`, `PINE_PRODUCTION_CALLABLE_METADATA` | The same data for the production profile, ready for an editor |
| `PINE_RUNTIME_IDENTITY`, `LUMEN_SCRIPT_EXECUTOR_VERSION`, `PINE_COMPILER_DIGEST`, `PINE_CATALOG_DIGEST` | Engine identity, for caches and bug reports |
| `PINE_MAIN_TIMEFRAME_INPUT_ID`, `PINE_MAIN_TIMEFRAME_GAPS_INPUT_ID` | Input IDs the compiler adds when `indicator()` sets `timeframe` or `timeframe_gaps`, so a host can show and change them |
| `PineFootprintError` | Error from a footprint request: a missing or failing `footprintGateway`, an invalid request or dataset, or a limit exceeded. Its `code` says which |
| `validatePineLibraryExports`, `validatePineLibraryRequestPolicy` | Library checks |
| `pineGlobalBindings`, `renamePineBindings`, `renamePineReceiverMethods`, `stripPineLibraryDemonstration` | Source helpers for linking libraries |
| Types | `CompileRequest`, `CompileResult`, `CompiledProgram`, `MarketBar`, `ExecutionResult`, `ExecutionDelta`, `StrategyResult`, `SessionOptions`, `MarketDataGateway`, `PineFootprintGateway`, `ProgramDescriptor`, and the rest of the contracts |

The built-in catalog is the same data the compiler uses, so an editor can
offer completions that match what will compile:

```ts
import { PINE_COMPATIBILITY, pineBuiltinRegistry } from "@lumencharts/script";

const taFunctions = pineBuiltinRegistry(PINE_COMPATIBILITY.strict)
  .filter((spec) => spec.namespace === "ta" && spec.form === "call")
  .map((spec) => spec.name);
```

## API coverage

Coverage is measured against an inventory of 860 distinct Pine Script® v6 API
forms: each function, variable and constant, with a call and a variable of the
same name counted separately. 834 of them can be computed from OHLCV data and
symbol metadata, and every one of those has executable evidence in the
engine's conformance suite. The other 26 need data from external providers and
are not part of the engine.

| Area | Namespaces | Forms supported |
| --- | --- | --- |
| Technical analysis and maths | `ta`, `math` | 69 / 69, 28 / 28 |
| Collections | `array`, `matrix`, `map` | 55 / 55, 49 / 49, 11 / 11 |
| Strategy | `strategy` | 96 / 96 |
| Drawings | `line`, `box`, `label`, `linefill`, `polyline`, `table` | 28 / 28, 30 / 30, 43 / 43, 6 / 6, 3 / 3, 23 / 23 |
| Plots and styles | `plot`, `hline`, `color`, `shape`, `location`, `size`, `display`, `format`, `scale`, `text`, `font`, `extend`, `xloc`, `yloc` | 100 / 100 |
| Inputs, strings and logs | `input`, `str`, `log`, `runtime`, `alert` | 13 / 13, 18 / 18, 3 / 3, 1 / 1, 3 / 3 |
| Bar, time and session context | `barstate`, `timeframe`, `session`, `dayofweek`, `chart` | 7 / 7, 14 / 14, 9 / 9, 7 / 7, 19 / 19 |
| Symbol context | `syminfo`, `ticker`, `currency`, `dividends`, `earnings`, `splits`, adjustment constants | 26 / 42, 9 / 9, 56 / 56, 5 / 5, 7 / 7, 2 / 2, 9 / 9 |
| Requests | `request`, `barmerge` | 2 / 10, 4 / 4 |
| Other built-ins | top-level functions and variables, `order`, `position` | 68 / 70, 2 / 2, 9 / 9 |

Not supported, because they need data the engine does not have:
`request.financial`, `request.economic`, `request.earnings`,
`request.dividends`, `request.splits`, `request.quandl`, `request.seed`,
`request.currency_rate`, `bid`, `ask`, and the analyst, float and expiry
fields of `syminfo`. Scripts that use them fail to compile with a diagnostic
rather than returning made-up values. A form being supported means the engine
implements it and has tests for it; it does not guarantee identical numbers to
any other implementation in every case.

## Documentation

- [Lumen Script in Lumen Charts](https://docs.lumencharts.com/charting-library/studies/lumen-script):
  running scripts on the chart, editor and error codes.
- [Custom indicators](https://docs.lumencharts.com/charting-library/studies/custom-indicators):
  the chart's JavaScript indicator API, for comparison.
- The TypeScript declarations in `dist/index.d.ts` document every option and
  result field.
- [CHANGELOG.md](CHANGELOG.md) lists what changed in each release.

## Use with AI agents

Lumen Script gives a model a fast, local way to check its own Pine code. Wrap
compile and run in a tool, return the diagnostics or a summary of the results,
and let the model iterate until the script compiles and does what was asked:

```ts
import { PINE_COMPATIBILITY, PineEngine, compile, type MarketBar } from "@lumencharts/script";

export async function checkPineScript(source: string, bars: readonly MarketBar[]) {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
  if (!result.program) {
    return {
      ok: false as const,
      errors: result.diagnostics.map(({ code, message, range }) => ({ code, message, line: range?.start.line })),
    };
  }
  const session = new PineEngine().createSession(result.program, {
    signal: AbortSignal.timeout(5_000),
    limits: { maxBars: 5_000 },
  });
  try {
    const output = await session.runBatch(bars);
    return {
      ok: true as const,
      plots: output.plots.map((plot) => ({ title: plot.title, last: plot.points.at(-1)?.value ?? null })),
      drawings: output.drawings.length,
      trades: output.strategy?.closedTrades,
      netProfit: output.strategy?.netProfit,
    };
  } finally {
    await session.close();
  }
}
```

Diagnostics carry stable codes and exact positions, which models use well. Keep
the result small (last values and counts, not whole series), and run model-written
scripts with a bar limit, a timeout and, in a server, in a worker or separate
process.

To let an assistant read and change a Lumen Charts chart, including scripts
running on it, see the Apache-2.0
[`@lumencharts/chart-automation`](https://github.com/lumenchartshq/chart-automation)
SDK.

## Use cases

**Charts and trading apps**

- Run user scripts on your own chart component and draw the results.
- Validate scripts in an editor as the user types, with inline errors.

**Backtesting and research**

- Backtest strategies over stored history on a server.
- Export indicator series for analysis in notebooks or data pipelines.

**Alerts and automation**

- Evaluate scripts on new bars and turn `alert()` events into notifications.
- Checkpoint sessions between ticks so a worker can pick up where another
  stopped.

**Developer tooling**

- Build linters, formatters and autocompletion on the built-in catalog.
- Give AI assistants a compile-and-run loop for the Pine code they write.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

The engine's parts live under `src`: `compiler` (lexer, parser, binder and code
generation), `runtime` (built-in functions and series), `engine` (execution
sessions) and `contracts` (shared types and the built-in catalog).

## Contributing

Bug reports are welcome as
[issues](https://github.com/lumenchartshq/lumen-script/issues). The most useful
report has the package version, the smallest script that shows the problem,
the bars it ran on, and the output you expected. We are not accepting pull
requests yet; [CONTRIBUTING.md](CONTRIBUTING.md) explains why and how releases
are made. Report security issues privately to support@lumencharts.com.

## License

Lumen Script is available under the GNU Affero General Public License, version 3 only. See LICENSE for the full terms.

An alternative commercial licence for the Lumen Script version included in our paid chart builds is available with eligible Lumen Charts Business and Enterprise subscriptions, subject to the Developer License Agreement. That licence permits the covered use without relying on the AGPL; it does not automatically cover other versions, forks or modifications.

You may use Lumen Script under the AGPL, including for commercial purposes, if you comply with its terms. The commercial option does not limit rights granted under the AGPL. Third-party components remain subject to their own licences.

The proprietary Lumen Charts library is a separate product and is not licensed under the AGPL by this repository.

Pine Script® is a trademark of TradingView, Inc. Lumen Script is not affiliated with, sponsored by or endorsed by TradingView. References to Pine Script describe language compatibility, not certification or guaranteed complete compatibility.

Commercial licensing enquiries: support@lumencharts.com.
