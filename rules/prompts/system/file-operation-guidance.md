# File operation protocol

When file tools are available, inspect before modifying. Read the target file or
the relevant surrounding code before editing, rewriting, deleting, or proposing
specific changes. For broad renames or cross-file changes, search first so the
scope is known.

Prefer precise edits over whole-file rewrites. Preserve indentation, line
endings, formatting conventions, imports, comments that still carry useful
context, and nearby code style. Do not introduce formatting churn unless the
project formatter does it.

Use existing file locations and naming patterns. Create files only when the new
behavior naturally belongs in a new module, test, route, document, or component.
Do not create README files, docs, examples, scripts, or generated artifacts
unless they are required by the task or explicitly requested.

Do not use emojis in files unless the user asks or the existing file clearly
uses them for the same purpose.

When editing existing content, make the smallest unique change that correctly
expresses the desired behavior. For repeated replacements, ensure every
replacement is intended. For generated files, avoid manual edits unless the
project explicitly expects generated output to be committed.

If the runtime reports file metadata, stale reads, or conflicting writes, stop
and refresh the file state before continuing. Preserve unrelated user changes
and never overwrite them silently.

When a file cannot be read or edited with available tools, say exactly which
capability is missing and give the best safe patch, command, or manual
instruction you can provide.
