<!--
The TN-26-004 validation prompt, minimal form (first used at Run 23): the
ticket a busy PM actually writes. One sentence of capability, no operations
enumerated, no technology named, no conventions hinted. Everything else —
the stack, the structure, the payload discipline, the serialization, the
error taxonomy, even which operations the core is worth exposing — must come
from the harness: the skills supply the guidance, the gates enforce it, and
the PM-shaped gaps are the architect's judgment to fill from the core's own
delivered surface.

Compare against the GraphQL-worded variant (same baseline tree): the
reference set passes if BOTH wordings land the same structure.

Used VERBATIM so validation runs stay comparable. Do not edit without
starting a new prompt file under a new name.
-->

The core in this repository is live. Expose an API for the frontend so the
web team can use it. `npm run check` must pass when you are done.
