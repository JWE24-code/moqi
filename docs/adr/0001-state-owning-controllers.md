# TuiApp delegates to state-owning controllers behind thin accessors

`TuiApp` was a 5,420-line class whose state and rules were interleaved with
every reaction. We extracted the state clusters into their own modules —
`SessionTabs`, `SearchState`, `LoginFlow`, `UsageStore`, `PeerList`,
`TurnRunner` — each owning both the state and the rules over it, while
`TuiApp` keeps thin property accessors (e.g. `get/set tabs`) so the dozens of
existing references needed no edits, and keeps the reactions: paint, status,
persistence.

The alternative — passing the app into free functions, or splitting the class
into mixins — would have either moved reactions away from the code that
phrases them or created pass-through shims that fail the deletion test. Where
a wrapper would have been a pass-through, we shipped nothing instead: no
`FleetController` exists because `FleetView` already owns the panel, and
`presenceKey` stayed on the app because it is one guard with no rules.

Consequence: new code touching a session tab, a search, a sign-in, the usage
ledger, the peer list, or a turn should go through its controller, not reach
into `TuiApp` fields. The accessors are a migration seam, not an invitation.
