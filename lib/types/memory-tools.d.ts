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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type MemoryStore } from './memory.ts';
/**
 * The three memory tools for one session. `store` is read at call time, so a
 * session whose directory is only known after setup (a resumed one) still
 * writes to the right project.
 */
export declare function memoryTools(store: () => MemoryStore): ToolDefinition[];
