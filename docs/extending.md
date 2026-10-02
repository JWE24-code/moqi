# Extending the terminal

The `ctx.tuiHost` seam other plugins extend moqi with. The panel side is drawn
in more detail in [docs/plugin-panels.md](plugin-panels.md).

## Extending the terminal

The app provides `ctx.tuiHost`, a service other plugins extend it with:

```ts
const dispose = ctx.tuiHost.registerShortcut({
  combo: 'ctrl+shift+g', label: 'git status', handler: () => { /* … */ },
})
ctx.tuiHost.setStatusLine('2 agents spinning')

// A command panel: `<name>` joins the palette; the host draws the rows,
// routes `enter`, and raises any masked prompt the panel asks for.
ctx.tuiHost.registerPanel({
  name: 'JevLoop',
  title: 'Jev Loop',
  description: 'Jev gates and API key (moqi-jev-loop)',
  rows: () => [{ id: 'gate', title: 'Pre-execute', subtitle: 'on', active: true }],
  activate: (id) => { /* toggle, or return { kind: 'secret', message, submit } */ },
})
```

A shortcut must carry `ctrl` or `alt`; a combination the app already uses is
refused rather than ordered, so a plugin can never swallow the quit
confirmation or a scroll key. `registerShortcut`, `setStatusLine`, and
`registerPanel` all return disposers, and the status line is one row —
replaced, not stacked, last registration wins — that the layout surrenders
first when the window is short. A panel owns what its rows mean; the host owns
how they look and which keys drive them. A panel is a fallback command, not an
override: if its name collides with a built-in or a Harness command, the app's
command wins in both the palette and `/name`. The host side of the seam lives in
one framework-free module, `src/tui/panel-host.ts`, so an action that throws
leaves the panel open rather than vanishing behind the error; the seam and its
adapter are drawn in [`docs/whiteboards/`](docs/whiteboards/).

Searching across sessions is built in: `/find --sessions <text>` reads the
stored session logs (plain or zstd) under `$DSH_HOME/sessions`, shows every
matching line with its project and speaker, and opens the session on `enter`.
The store is read-only here; a compressed log on a Node too old to decode it is
reported as skipped, never as a wrong answer.
