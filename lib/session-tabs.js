export class SessionTabs {
    tabs;
    active = 0;
    bellEnabled;
    constructor(tabs, options = {}) {
        this.tabs = tabs;
        this.bellEnabled = options.bell !== false;
    }
    /** The tab bar's view of the open sessions. */
    summaries() {
        return this.tabs.map((tab, index) => ({
            id: tab.id,
            title: tab.title,
            status: tab.status,
            active: index === this.active,
        }));
    }
    /** Find the session that owns an agent, if any. */
    forAgent(agent) {
        return this.tabs.find((tab) => tab.agent === agent);
    }
    /** The tab currently on screen. */
    current() {
        return this.tabs[this.active];
    }
    /**
     * Move a session to a new status, ringing the bell when it becomes `ready`.
     *
     * `ready` is the only state worth a sound: a turn finished and its answer is
     * waiting. A session you are already looking at is marked seen instead, so
     * the bar does not nag about a reply on screen.
     */
    setStatus(tab, status) {
        const wasReady = tab.status === 'ready';
        if (status === 'ready' && this.tabs[this.active] === tab) {
            tab.status = 'idle';
            if (!wasReady)
                this.ring();
            return;
        }
        tab.status = status;
        if (status === 'ready' && !wasReady)
            this.ring();
    }
    /** Sound the terminal bell, unless it has been turned off. */
    ring() {
        if (!this.bellEnabled)
            return;
        try {
            process.stdout.write('\u0007');
        }
        catch {
            // A closed stdout is not a reason to fail a turn.
        }
    }
    /** Append a new session and make it active. */
    append(tab) {
        this.tabs.push(tab);
        this.active = this.tabs.length - 1;
    }
    /** Replace the whole strip (the restore path), activating `active`. */
    replaceAll(tabs, active) {
        this.tabs = tabs;
        this.active = active === -1 ? 0 : active;
    }
    /** Switch the view to another session, marking it seen. */
    select(index) {
        if (index < 0 || index >= this.tabs.length)
            return undefined;
        this.active = index;
        const tab = this.tabs[index];
        // Looking at it counts as reading it.
        if (tab !== undefined && tab.status === 'ready')
            tab.status = 'idle';
        return tab;
    }
    /**
     * Close the session at `index`, keeping at least one open.
     *
     * @returns the closed tab, or `undefined` when it was the last session.
     */
    remove(index) {
        if (this.tabs.length <= 1)
            return undefined;
        const [closed] = this.tabs.splice(index, 1);
        if (this.active >= this.tabs.length)
            this.active = this.tabs.length - 1;
        else if (index < this.active)
            this.active -= 1;
        return closed === undefined ? undefined : { closed };
    }
}
