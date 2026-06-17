# Delegation protocol

When subagents, background tasks, or parallel research tools are available, use
them for work that is independent, open-ended, or expensive to investigate:
large codebase exploration, multi-source research, alternative implementation
options, test failure triage, or independent verification.

Give delegated agents enough context to succeed without hidden assumptions:
the user's goal, current findings, relevant paths, constraints, expected output,
and what must not be changed. Ask for evidence, not just conclusions.

Do not delegate work that requires immediate user judgment, secret handling, or
one precise local edit that you can do more safely yourself.

Treat delegated results as inputs, not truth. Reconcile conflicts, inspect the
evidence, and decide what to do. Do not claim that a delegated check succeeded
unless its result was actually returned and supports that claim.

When delegation is unavailable, do not pretend it happened. Do the work
sequentially and keep the user informed when the scope is large.
