/**
 * The session mode `shift+tab` cycles: what the agent may do, as one word.
 *
 * Built from two Harness knobs: the permission preset (`dsh-permission-presets`:
 * a sandbox mode plus an approval policy) and plan mode (`dsh-plan-mode`).
 * The cycle is
 *
 *   read-only → workspace-write → plan → read-only
 *
 * Plan mode keeps the `workspace-write` sandbox: plan mode itself restrains by
 * guidance, not by removing tools, and when the user approves a plan the
 * agent goes straight on to implement it — under a read-only sandbox every
 * write of that implementation would fail. `danger-full-access` is never a
 * step: it is reached only by naming it (`/permission danger-full-access`),
 * and `shift+tab` from it — or from any custom knob mix — goes to read-only,
 * the narrow end.
 *
 * Pure: no Harness imports, so the cycle is tested offline.
 * @module
 */
/** One step of the cycle, or whatever preset name is in force outside it. */
export type SessionMode = 'read-only' | 'workspace-write' | 'plan' | (string & {});
/** What applying a mode means for the two knobs. */
export interface ModeTarget {
    mode: 'read-only' | 'workspace-write' | 'plan';
    preset: 'read-only' | 'workspace-write';
    plan: boolean;
}
/** The mode a session is in, from its preset and plan state. A pending plan switch counts. */
export declare function currentMode(preset: string, planActive: boolean): SessionMode;
/** Where `shift+tab` goes from `mode`. */
export declare function nextMode(mode: SessionMode): ModeTarget;
/**
 * The footer badge for a mode, or undefined for the everyday default — the
 * badge is there to flag a session that is narrower or wider than usual.
 */
export declare function modeBadge(mode: SessionMode | undefined): string | undefined;
