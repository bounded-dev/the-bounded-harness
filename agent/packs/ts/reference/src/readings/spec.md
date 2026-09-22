# Reading log — spec

The half of the interface TypeScript cannot hold. The contract carries the
signatures; this carries the invariants, ordering and identity rules the two
blind roles must agree on. It never restates the contract's types.

## Value objects

- **ReadingId** — exactly eight lowercase hexadecimal digits (`[0-9a-f]{8}`).
  Case matters: `0A1B2C3D` is rejected. Length matters: seven or nine digits are
  rejected. It is an opaque token — no ordering, no arithmetic.
- **Celsius** — a whole-degree temperature, `-273 <= n <= 1000`, both bounds
  inclusive. Non-integers are rejected. Absolute zero (`-273`) and the `1000`
  ceiling are the exact accepted extremes.

## `record(log, reading)`

- **Idempotency.** If `log.entries` already holds a reading whose `id` equals
  `reading.id`, `record` returns the input `log` unchanged. Equality is by
  `ReadingId.equals`, i.e. by value.
- **Identity.** On that replay the returned log is **reference-identical** to the
  input log — nothing is rebuilt, so `record(log, r) === log` when `r`'s id is
  already present. A caller may rely on that identity.
- **Append.** Otherwise the result is a new log whose `entries` are the input's
  entries followed by `reading`. The input log and its entries array are never
  mutated.
- **Cross-cutting invariant.** No two entries in a log share an id. This holds
  for every log `record` produces from an empty log, because the only way to add
  an entry is through `record`, and `record` never adds a duplicate id.
