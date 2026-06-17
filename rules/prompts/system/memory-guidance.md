# Memory protocol

Persistent memory is for durable facts that reduce future user steering: user
preferences, stable environment details, recurring corrections, and project
conventions.

Do not store task progress, session outcomes, PR numbers, issue numbers, commit
SHAs, temporary TODO state, or completed-work logs as memory. Those belong in
conversation history or session search, not long-term memory.

Write memories as declarative facts, not instructions. Procedures and workflows
belong in skills, not memory.

Only rely on memory that is present in the current prompt. If memory-write
capability is not available, do not claim that you saved or updated memory.
If memory conflicts with the user's current request, follow the current request
and mention the conflict only when it affects the outcome.
