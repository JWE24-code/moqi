/**
 * `/jobs` formatting: a background job list rendered as markdown.
 *
 * Pure, like the rest of `tui/`: the app layer hands over snapshots and owns
 * the registry calls.
 * @module
 */
/** The subset of a job snapshot this module formats. */
export interface JobLike {
    id: string;
    kind: string;
    label: string;
    status: string;
    detail?: string;
    startedAt: number;
    finishedAt?: number;
}
/** A compact "3s" / "4m" / "2h" duration. */
export declare function formatDuration(seconds: number): string;
/** The mark a job's state earns in the list. */
export declare function jobMark(status: string): string;
/**
 * The `/jobs` overlay body.
 *
 * Running jobs first, then the settled ones newest-first, because the list
 * exists to answer "what is still going" before "what happened".
 */
export declare function renderJobs(jobs: readonly JobLike[], now?: number): string;
