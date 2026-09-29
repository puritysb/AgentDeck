# 2026-09-19 — Session-order pins: real-daemon validation receipt (#273)

The Session ordering gate's last mechanism question — does pinning reorder
real observed sessions on the deck order, and does the pin survive daemon
restarts and a same-uuid session reappearance? — was validated live on the
production machine after #347 merged, against the launchd-supervised Node
daemon on 9120 serving build `64af196fe357` (`agentdeck daemon restart`,
handed back to the unit afterwards).

Sequence and observed wire order (`sessions_list`, the order every deck
renders): baseline roster of four real sessions (openclaw-gateway, a real
Claude session in AgentDeck, the validating agent's own observed opencode
session, and an idle opencode session in ViewTrans). Pinning the ViewTrans
session `observed:opencode:33718` to `-1` and the Claude session prefix
`observed:claude:512d3058` to `+3` (prefix resolution restored the full id)
reordered the roster exactly as specified: ViewTrans slot 4 → 1, Claude
slot 2 → 4, weight beating the agentType grouping. After
`agentdeck daemon restart` both pins survived (`session-order.json` → load →
enricher) and the slots held. A throwaway Claude session launched with a
fixed `--session-id` (interactive, zero API turns) appeared as
`observed:claude:<uuid>`, was pinned to `-9` (slot 1), vanished from the
roster when killed, and — relaunched with the SAME uuid — reappeared at
slot 1 with the pin already applied: the `claude --resume` mechanism, since
a resume is precisely a same-uuid reappearance. All three pins were then
cleared and the roster returned to the baseline order; the daemon was
restarted once more to hand supervision back to the launchd unit.

Scope note: the evidence is the wire order the Stream Deck / D200H render
(they display daemon-sorted `sessions_list` by design, pinned by existing
surface tests); the physical one-glance confirmation on the desk was left
to the maintainer. The managed `--weight` retirement question is the
remaining open decision in #273, now unblocked by this receipt.
