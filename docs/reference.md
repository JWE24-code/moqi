# Reference

Flags, keys, commands, palettes, vim mode, interface language, and MCP.

## Flags

| Flag | Meaning |
|---|---|
| `--resume <id>` | Open a persisted session instead of starting a new one |
| `--model <name>` | Model to select for this run |
| `--thinking` | Start with reasoning output visible |
| `--context-limit <n>` | Override the context budget; the default is the model's own capacity |
| `--mouse` | Report mouse events; the default now, and accepted so an alias that passes it keeps working |
| `--no-mouse` | Disable mouse reporting; the wheel scrolls and the tab bar clicks by default, and shift selects text for the terminal |
| `--no-bell` | Stay silent when a session finishes |
| `--vim` | Modal vim editing in the composer: `esc` for normal mode, `i` to insert |
| `--peer <host>` | Device to include in the fleet overview; repeatable |
| `--no-restore` | Start with one empty session instead of reopening the last ones |
| `--version` | Print the app version |

`MOQI_CONTEXT_LIMIT` sets the same budget; `MOQI_THEME=light\|dark`
overrides background detection; `NO_COLOR` disables styling.

## Keys

| Key | Action |
|---|---|
| `enter` | Send · steers into a running reply · a menu on top chooses with `enter` too |
| `shift+enter` | Insert a newline · `ctrl+j` does the same · multi-line pastes land whole |
| `↑` / `↓` | On the first / last composer row, recall earlier prompts |
| `/` | Command palette, 3 rows at a time and scrolling past that · `tab` accepts · `esc` dismisses |
| `@` | File completion over the workspace · `tab`/`enter` accepts · `esc` dismisses |
| `?` | Open the key reference on an empty composer |
| `esc` | Interrupt a streaming reply |
| `esc` (alone) | Recognized after a 50 ms grace, so a lone press is never mistaken for a sequence's first byte |
| `alt+e` | Edit the draft in `$VISUAL`/`$EDITOR` · non-zero exit keeps it |
| `alt+↑`/`alt+↓` | Select a transcript turn (gold bar) · `esc` clears |
| `alt+c` | Copy the selected turn over OSC 52 |
| `tab` | While a reply streams: queue the prompt for after it |
| `ctrl+enter` | Interrupt the reply and send now (needs a terminal that reports it) |
| `ctrl+n` / `ctrl+r` / `ctrl+t` | New session · resume · toggle thinking |
| `pgup`/`pgdn` | Scroll a page · `ctrl+↑`/`ctrl+↓` half a page |
| `shift+↑`/`shift+↓` | Scroll one line · `ctrl+g` jumps back to the newest |
| `ctrl+o` | Show or hide each tool call's outcome, under the call itself |
| `ctrl+x` | Compact the session |
| `ctrl+b` | Expand or collapse the background-agent strip |
| `ctrl+y` | Copy the last reply to the clipboard |
| `ctrl+f` | Fleet overview: sessions across every device |
| `n` / `N` | With a search open and an empty composer, next / previous match |
| `alt+1`…`alt+9` | Jump to a session · `alt+n`/`alt+p` cycle · `tab` cycles on an empty composer |
| `ctrl+a`/`ctrl+e`/`home`/`end`, `ctrl+w`, `ctrl+k` | Line start/end, delete word, kill to end |
| `ctrl+u` | Clear the composer line (readline) |
| `ctrl+d` | Delete forward · `alt+b`/`alt+f`, `ctrl+←`/`ctrl+→` word motion |
| `ctrl+c` | Sessions menu · press again within 1.5s to quit |

In a list (`/model`, `/theme`, `/resume`): type to filter, `enter` selects, `esc` closes;
`ctrl+n`/`ctrl+p` or the arrows move, `pgup`/`pgdn` move by ten, `home`/`end`
jump, and `ctrl+u` clears the filter.

## Color palettes

`/theme` opens a picker over the palettes the app ships with; `/theme <name>`
switches straight away. Moving through the picker repaints the whole app in
the highlighted palette — browsing by arrow key *is* trying it on — and `esc`
puts back what was in force; `enter` keeps what you landed on. The same
preview applies to `/lang`. And `/theme <par<Tab>` completes a palette name,
shared prefix first, then opens the picker; `/lang <par<Tab>` does the same
for languages.

| Theme | |
|---|---|
| `moqi` | the default — the app's own: ink wash on Deep Ink, cinnabar for warning |
| `ayu` | warm neutrals, orange accent |
| `catppuccin` | soft pastels, easy on the eyes (Latte / Mocha) |
| `contrast` | saturated hues on pure black/white; maximum legibility |
| `dracula` | vivid neon on purple; dark canonical, light derived |
| `everforest` | muted organic greens, low glare |
| `gruvbox` | warm retro earth tones, medium contrast |
| `kanagawa` | sumi-e ink wash; wave dark, lotus light |
| `material` | Android's palette; Darker dark, Lighter light |
| `modus` | WCAG-contrast-checked pair; Operandi light, Vivendi dark |
| `monokai` | the classic vivid editor scheme; dark canonical |
| `nord` | cool arctic blues, low saturation |
| `one` | Atom's classic; One Light and One Dark |
| `paper` | a page and one red accent; ink dark twin |
| `phosphor` | green CRT glow; amber for warnings |
| `rose-pine` | muted purples on a soft ink background; the former default |
| `solarized` | Schoonover's balanced pairing |
| `synthwave` | hot pink on indigo; the outrun sunset |
| `tokyo-night` | city-night blues; Night dark, Day light |
| `tomorrow` | muted neutrals; hue as seasoning |
| `mono` | greyscale, maximum contrast, no color coding at all |

Every palette defines both a light and a dark variant, because *which* palette
is in force and *which background* it is drawn against are separate questions.
`MOQI_THEME=light|dark` still forces the variant (the `COLORFGBG`
convention decides otherwise, and dark is the fallback), and `NO_COLOR` or
`TERM=dumb` still turns color off entirely — under those the theme has nothing
to do and picking one changes nothing.

`mono` is the accessibility option: it drops the hues rather than trying to
keep them, so success and failure no longer differ by color. Nothing in the
app relies on color alone — a failed tool call prints `✗` and its error text
either way — so what is left is legible where a hue-based palette is not.
`contrast` is the other accessibility corner: it keeps the hues but pushes
each to a saturated extreme against a pure base, and `modus` is the
middle path — a pair built to published WCAG contrast guarantees.

`moqi` is the app's own and the default: a Chinese ink painting, which is
where the name comes from (墨气). Deep Ink ground, Xuan Paper text, Ink Wash
selection and borders, Slate Smoke for the muted layer; the accents stay in
the same vocabulary — cinnabar for warning, the way a seal stamp carries the
painter's mark, an indigo wash for the accent, celadon, bamboo, and ochre for
the semantic slots. The light variant is the same painting on paper: the same
inks, the accents pressed darker to carry on Xuan.

Where a palette publishes both variants, both are used as published (the
exceptions are documented in the table: Dracula, Monokai, and Nord have no
light variant of their own, so one is derived from their hues the same way);
`paper`, `phosphor`, `synthwave`, and `contrast` are this app's own, built for
styles no published palette covers — minimal paper, the green CRT, the outrun
sunset, and maximum-contrast color.

The choice is saved with the rest of the durable state and applied before the
first frame, so it survives a restart. Switching repaints the whole screen at
once, since a palette change moves the color of nearly every cell.

The theme is **per session**, the same way the model is: `/theme` in one
conversation leaves every other tab on the palette it already had, switching
tabs repaints in whichever one that tab is on, and a new session starts from
the theme of the one it was opened from rather than the stored default —
which is still what a session started *without* one, like the very first tab
of a fresh launch, falls back to. A restored session brings its own theme back
too; one this build no longer ships (renamed or removed since) falls back to
the current default instead of leaving the tab on nothing.

## Vim mode

`--vim` at launch turns the composer modal. It starts in INSERT — enabling vim
never changes what typing does — and `esc` switches to NORMAL, where the
footer shows the mode and bare keys follow vim:

| NORMAL key | |
|---|---|
| `h` / `l` / `0` / `^` / `$` / `w` / `b` | motion, with vim's word-start `w` rather than readline's end-of-word |
| `i` / `I` / `a` / `A` / `o` / `O` | enter INSERT at, before, after, or on a new line |
| `x` / `X` / `dd` / `d$` / `d0` / `dw` | delete a character, a line, to the end, to the start, a word |
| `u` | undo the last vim edit (100 deep) |
| anything unbound | swallowed, so a stray `j` cannot type |

While vim mode is on, `esc` belongs to the editor: `ctrl+c` is the interrupt,
which is also what the footer's mode badge is there to remind you of. The mode
is session-scoped and not persisted, and the vim layer only ever touches the
composer — a panel, picker, or fleet screen owns the keyboard when it is open.

## Interface language

`/lang` switches the interface between English and Simplified Chinese and
remembers the choice across restarts. The translated surface is the chrome you
read: the welcome, the full key reference, the trust panels, and the footer
hints. Operational status lines stay English on purpose — they are diagnostics
that change with every release, and a half-translated diagnostic is worse than
an English one. A missing key falls back to English and then to its own name,
so nothing ever renders blank.

## MCP servers

`/mcp` shows which MCP servers' tools are mounted here, grouped by server, by
reading the tool registry for bridge-prefixed names (`mcp__server__tool`,
`server/tool`). Servers are declared by composition, not at runtime, so the
pane says where to add one instead of pretending to manage them live — and it
recognizes MCP patterns narrowly enough that a path like `src/tui/state.ts` is
never mistaken for a server.

## Commands

The palette merges two sources, so it shows whatever the Harness has actually
registered — `/compact` from `command-compact`, plus anything a plugin adds —
alongside the app's own:

| Command | Owner |
|---|---|
| `/compact`, and any other plugin command | `ctx.commands` (the Harness registry) |
| `/new`, `/sessions`, `/close`, `/resume`, `/delete`, `/rename`, `/model`, `/theme`, `/plugins`, `/thinking`, `/tools`, `/usage`, `/export`, `/find`, `/unqueue`, `/interrupt`, `/copy`, `/rewind`, `/fork`, `/tree`, `/jobs`, `/mcp`, `/lang`, `/providers`, `/dispatch`, `/fleet`, `/peer`, `/update`, `/help`, `/exit` (`/quit`) | this app |

Unknown commands are dispatched to `ctx.commands.execute()` and only reported
as unknown if the registry also rejects them.
