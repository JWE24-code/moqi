/**
 * A bounded, cached walk of the workspace for `@` file completion.
 *
 * The listing is refreshable rather than watched: completion is an
 * interactive nicety, so a few seconds of staleness after a checkout or a
 * build costs nothing, while a filesystem watcher would cost a handle and a
 * failure mode.
 * @module
 */
export interface DirectoryListing {
    files: {
        path: string;
        directory: boolean;
    }[];
}
/** One workspace's file list, recomputed lazily on demand. */
export declare class FileIndex {
    private readonly root;
    private entries;
    private readAt;
    private reading;
    constructor(root: string);
    /** Every workspace-relative file path, oldest acceptable snapshot or fresh. */
    list(): string[];
    /** Synchronously rebuild the listing. Errors leave the previous snapshot. */
    refresh(): void;
    private walk;
    /** One directory entry: descend into it, or add the file under its root path. */
    private walkEntry;
    /**
     * List one directory for a path-shaped query, relative to the workspace
     * root. `.` and `..` are offered alongside the entries so navigation works
     * the way a shell expects.
     */
    listDir(relativePath: string): DirectoryListing;
}
