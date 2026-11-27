# The state stream

Each reader surface opens one server-sent event stream from the Host, receives
the archive once, and then only what changed. This note covers what the wire
carries, how a surface that reconnected catches up, and what the stream costs.
The boundaries it sits on are reviewed in [`async-api.md`](async-api.md).

The stream is pulled. The route asks the Host for the next frame, writes it, and
only then asks for another, so a surface that is slow to read stops the producer
at the source instead of filling a queue in the request handler; what it falls
behind in is the revision cursor, and the kept history decides whether it is
caught up by a delta or by the whole state.

The wire carries a digest of a row: its body is cut to 400 characters and the
row says how long the real one is. The list only ever draws a 240-character
digest, and the text filter is answered by the Host, so nothing that needs the
full text travels with the list; an article that opens reads the one row it
shows, whole, over `/gitfeed/api/item`. The older `/state` route still answers
with whole bodies, because a page from before this change may still poll it.

The reader does not poll for its own state. Each surface opens one server-sent
event stream at `/gitfeed/events` when it mounts, receives the whole archive
once, and from then on only what changed: the rows a refresh added or repaired,
and the marks that moved. The Host keeps a live copy of what it last read, diffs
each new read against it, and sends the difference — a fetch that lands
seventeen rows ships seventeen rows, a mark ships two ids, and a quiet minute
ships nothing at all. A probe of the data root (twenty stats, well under a
tenth of a millisecond) runs every few seconds while a surface is attached, so a
fetch from the CLI, the agent tool, or a second Host reaches the reader too.

Revisions are the cursor. Every delta carries the next number; a surface that
reconnects asks from the last number it saw, and a gap the Host cannot explain
(it restarted, or the surface fell further behind than the history kept) is
answered with the whole state rather than a delta that would be wrong. Marks
travel the same way in the other direction, so a row read on one device leaves
the unread list on the other without either side asking.

The stream replaces a 60-second poll with a full model behind it. On a personal
library of 379 subscriptions and 3,860 items, an items write cost every open
surface 26.9 MB of JSON, and the poll itself cost the Host five `git` spawns
(190 ms) even when nothing had changed; a delta for the same write is about
100 KB, and an idle surface costs a stat probe every few seconds. The first
frame a surface receives is that model as digests — 25.7 MB before, 2.3 MB now
(0.84 MB compressed).

There is no second path. A surface that cannot open its stream — a page whose
client bundle is newer than the running Host, a proxy that buffers event
streams — says the Host cannot be reached and keeps trying, and the reader is
empty until it can. Restart the Host after updating the plugin, then reload the
page; that is the same restart a Host-side change needs anyway. The old `/state`
route stays on the Host because an older page may still be polling it, but this
client does not.

The text filter is answered by the Host, which holds every body whole: a query
travels as text and comes back as ids, and the surface keeps filtering by feed,
filter, and read state itself. That is what lets the wire carry a digest of a
row instead of its body — and what keeps a query matching text the list does not
have.

The first frame after a restart costs one read of the archive plus two git
commands, not five: branch, divergence, and dirty state come from one
`status --porcelain=v2 --branch`, started while the item model is being parsed
rather than after it. On that library the first frame arrives in about 0.23 s
instead of 0.38 s.

The archive is not re-read to answer questions the Host already can. The item
model keeps each shard's rows keyed by that shard's size and modification time,
so a fetch that appends to one month's file re-reads one file instead of
twenty-six megabytes; a fetch run takes the ids it already holds from that
model instead of scanning the stores, and leaves the orphan sweep to the
unsubscribe that already removed them. On the same library, one fetch run plus
the reader catching up went from about 0.9 s of Host CPU to about 0.08 s. The
git facts behind the status line are read on a change or every five minutes,
not on every run, because a refresh writes only the ignored local cache.

