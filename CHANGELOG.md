# Changelog

Each release of `@lumencharts/script` has a section here. The notes for a
version also appear on its GitHub release.

## 0.1.0

First release of Lumen Script, the engine that compiles and runs Pine Script®
v5 and v6 indicators and strategies.

- `compile` turns a script into a program, with diagnostics for anything it
  cannot run.
- `PineEngine` sessions run a program bar by bar: whole histories, appended
  bars, real-time updates of the last bar, and checkpoints to save and resume.
- Results include plots, drawings, alerts, logs and strategy reports.
- Two compatibility profiles: the dated production profile and a fixed
  baseline.
- `validatePineLibraryExports` and `validatePineLibraryRequestPolicy` check
  library scripts. `compile` does not run a `library()` script or resolve
  `import`; linking imported libraries is up to the host.
