# moqi

A terminal app for DeepSeek Harness. This is the glossary of the app's own
domain language — what the terms mean here, not how they are implemented.

## Language

**Stored session**:
A finished-or-live conversation persisted under the Harness session store, as
either a plain `.jsonl` log or a zstd-compressed one.
_Avoid_: transcript, chat file

**Log**:
The durable per-session event file. Exists in two forms — plain JSONL and
zstd-compressed — and is append-only; readers never write it.
_Avoid_: history file

**Project key**:
The encoded directory name that groups stored sessions by the project they
were started in.
_Avoid_: repo key, workspace

**Fork parent**:
The session a rewound-and-forked session descends from, recorded in its
header; `/tree` renders the lineage.
_Avoid_: parent chat, origin

**Session hit**:
One matching line from a cross-session search, trimmed to a picker row with
enough context to recognize the conversation.
_Avoid_: match, result row

**Gate**:
A named switch from the JevLoop service that can be toggled at runtime and
persists across restarts.
_Avoid_: flag, toggle

**Sessions view**:
The cross-device list opened with `ctrl+s` (or `/sessions`): every live session
on this device and on its peers, grouped by device, with a first row that
starts a new session here.
_Avoid_: fleet

**Tiled view**:
The layout that tiles every open session on screen at once, toggled with
`ctrl+t` (or `/tiled`).
_Avoid_: stack, stacked view

**Permission rule**:
An allow rule — a tool, optionally a command pattern and the widest sandbox
mode it may grant — that answers a matching approval without the panel. Kept
for this session, this project, or everywhere.
_Avoid_: grant, whitelist, permission (alone: that is the Harness preset)

**Session mode**:
What the agent may do in a session, as `shift+tab` cycles it: read-only,
workspace-write, or plan. Built from the Harness's permission preset and plan
mode.
_Avoid_: permission mode, sandbox (alone)

**Memory**:
A fact the agent keeps across sessions, one file each, listed in a `MEMORY.md`
index — for this project or everywhere. The agent's notebook, as opposed to
the instruction files, which are the user's.
_Avoid_: notes, knowledge base, AGENTS.md

**Quick note**:
A one-line `# ` composer entry that is kept — as a memory or an instruction
line — instead of being sent.
_Avoid_: comment, heading

**Workspace**:
Where one session works — the launch directory, a `moqi/` branch there, or a
worktree — together with the rules for closing it.
_Avoid_: checkout (for the whole idea), sandbox
