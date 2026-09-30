# Plugin panels on the `tuiHost` seam

`ctx.tuiHost.registerPanel(panel)` lets a plugin contribute a command panel:
rows the host draws, an `enter` action, and an optional masked secret prompt.
[`moqi-jev-loop`](https://github.com/JWE24-code/moqi-jev-loop) is the worked
example — `/JevLoop` lists the TypeSafe API key and the four Jev gates.

The seam is deliberately in three pieces:

| Module | Layer | What it is |
|---|---|---|
| `src/tui-host-core.ts` | framework-free | the contract (`TuiPanel`, `TuiPanelRow`, `TuiPanelSecret`) and `PanelRegistry` |
| `src/tui-host.ts` | Cordis | the `tuiHost` service: `registerPanel` · `panels` · `findPanel` |
| `src/tui/panel-host.ts` | framework-free | the host adapter: open, activate, prompt, fail, refresh |

## Why the host adapter is a module

Before, the host side was spread through `TuiApp`: an `activePanel` field, three
methods (`showPanel`, `activatePanelRow`, `promptSecret`), a palette merge, a
`runCommand` lookup, and a picker branch. That is one behaviour in six places.
`PanelHost` puts it behind four calls — `commands()`, `openByName()`, `open()`,
`activate()` — and takes the app's surfaces as a `PanelSurface` port: the
picker, the masked prompt, the status slot, and a repaint. Two adapters satisfy
the port — `TuiApp`, and the recording fake in `tests/panel-host-smoke.ts`,
which drives the whole async lifecycle (activation, prompt, submit, cancel, and
both failure paths) with no Cordis and no terminal.

Masked prompting stays in the app: `beginLogin` already owns the `LoginPanel` +
`pendingLoginPrompt` machinery, and the panel adapter reuses it through
`askSecret` rather than growing a second implementation.

## Precedence

A panel may claim a name the app and the Harness registry both leave free. It
cannot shadow either: the palette hides a colliding panel, and `runCommand`
consults panels only after a built-in has returned and the Harness has reported
the command unknown.

## The maps

- [`whiteboards/moqi-tui-host.svg`](whiteboards/moqi-tui-host.svg) — the seam
  contract: what a plugin may contribute, and the registry each claim lives in.
- [`whiteboards/moqi-panel-host.svg`](whiteboards/moqi-panel-host.svg) — the
  host adapter and the one place `rows()` is called.

Each map ships with an editable `.excalidraw`, a `.json` code map, and an
`.annotations.yaml` recording why each function exists.
