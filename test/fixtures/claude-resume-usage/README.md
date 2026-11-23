# Claude resume reconciliation fixture

Synthetic Claude-shaped transcript records and independently specified cumulative SDK
result frames. These are test inputs, not a capture of operator data or a live API run.
Requests 1 and 2 form result 1; request 3 forms result 2. The driver and database are
closed, then a resumed driver receives result 3, which includes request 4 and all history.
Request 1 has two content-block records sharing its message ID and request ID; it bills once.

The test independently prices the deduplicated transcript requests. It never constructs
result-frame costs from that calculation or uses Mission Control's accounting helpers
for the reference total. Both 5-minute and 1-hour writes are nonzero, including in the
post-resume request; the aggregate cache-creation field is not billed a second time.

Pinned Claude Sonnet 4.6 standard, global Claude API list rates in USD per million tokens:
input 3, output 15, cache read 0.30, 5-minute cache write 3.75, 1-hour cache write 6.
Source: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
checked 2026-11-05. No batch, regional, fast-mode, tool, or negotiated pricing applies.
These constants are a test reference, not a production rate-table update.

The four request costs are $0.01665, $0.00345, $0.00606, and $0.00789, totaling $0.03405.
The transcript has 200 input, 280 output, 18,500 cache-read, 2,000 five-minute-write and
2,700 one-hour-write tokens. The ledger combines the write tiers into 4,700 cache-write
tokens while retaining the provider-reported cost that priced those tiers separately.
