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
