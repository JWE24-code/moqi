/**
 * The agent-facing memory tools — `memory_save`, `memory_read`,
 * `memory_forget` — over one session's {@link MemoryStore}, and the prompt
 * section that lists what is saved.
 *
 * Deliberately thin: every rule (slugs, the index file, front matter, the
 * prompt budget) lives in `memory.ts` and is tested there. This module only
 * adapts it to the Harness tool and prompt seams, which is why it is the one
 * that imports `@deepseek-ai/dsh-tools`.
 * @module
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MEMORY_TYPES } from "./memory.js";
const SCOPES = ['project', 'global'];
/** One text block, the only content these tools return. */
function text(value) {
    return [{ type: 'text', text: value }];
}
/** A memory as the model reads it back. */
function render(memory) {
    return [`# ${memory.title}`, `${memory.type} · ${memory.scope} · ${memory.description}`, '', memory.body].join('\n');
}
/** Look a memory up in the named scope, or project first, then global. */
function find(store, name, scope) {
    if (scope !== undefined)
        return store.read(scope, name);
    return store.read('project', name) ?? store.read('global', name);
}
/**
 * The three memory tools for one session. `store` is read at call time, so a
 * session whose directory is only known after setup (a resumed one) still
 * writes to the right project.
 */
export function memoryTools(store) {
    const save = defineTool({
        name: 'memory_save',
        description: [
            'Save one durable fact for future sessions, so the user never has to repeat it.',
            'Worth saving: who the user is and how they like to work; a correction or a confirmed approach (say why);',
            'project facts that are not in the code or git history (decisions, constraints, deadlines);',
            'and pointers to outside resources. One fact per memory. Saving under an existing name replaces it —',
            'update rather than duplicate, and check the memory index first.',
            'Do not save what the repository already records, or what only matters to this conversation.',
            'scope: "project" (default) for this project only, "global" for every project.',
        ].join(' '),
        parameters: {
            name: { type: 'string', required: true, description: 'Short title; its slug is the key' },
            description: { type: 'string', required: true, description: 'One line: what it is, for the index' },
            type: { type: 'string', enum: MEMORY_TYPES, required: true, description: 'user, feedback, project, or reference' },
            body: { type: 'string', required: true, description: 'The fact; for feedback and project, add Why: and How to apply:' },
            scope: { type: 'string', enum: SCOPES, description: 'project (default) or global' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(value),
        },
        async execute(args) {
            const saved = store().save(args.scope ?? 'project', {
                name: args.name,
                description: args.description,
                type: args.type,
                body: args.body,
            });
            return `saved "${saved.title}" (${saved.scope}) — every session sees it in its memory list from its next request`;
        },
    });
    const read = defineTool({
        name: 'memory_read',
        description: 'Read one saved memory in full. The memory index in your instructions lists them by title; read one when it is relevant to the task.',
        parameters: {
            name: { type: 'string', required: true, description: 'Title or slug from the index' },
            scope: { type: 'string', enum: SCOPES, description: 'Omit to look in project, then global' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const memory = find(store(), args.name, args.scope);
            return memory === undefined ? `no memory named "${args.name}"` : render(memory);
        },
    });
    const forget = defineTool({
        name: 'memory_forget',
        description: 'Delete a memory that turned out to be wrong or no longer applies.',
        parameters: {
            name: { type: 'string', required: true, description: 'Title or slug from the index' },
            scope: { type: 'string', enum: SCOPES, description: 'Omit to look in project, then global' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(value),
        },
        async execute(args) {
            const memory = find(store(), args.name, args.scope);
            if (memory === undefined)
                return `no memory named "${args.name}"`;
            store().forget(memory.scope, memory.name);
            return `forgot "${memory.title}" (${memory.scope})`;
        },
    });
    return [save, read, forget];
}
