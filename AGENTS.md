# AGENTS.md

This file gives Codex project-specific instructions for work inside `my-agent`.
Keep it updated as the project grows.

## Project Structure

- `rules/`: Store project rules, prompts, checklists, and reusable agent guidance.

## Working Guidelines

- Read relevant files before making changes.
- Keep changes small, focused, and consistent with the existing project structure.
- Do not remove user-created files or content unless explicitly requested.
- Add new rules under `rules/` using clear, descriptive filenames.
- When design documents, architecture notes, PRDs, or project rules change, check whether `AGENTS.md` should be updated so future Codex sessions inherit the new guidance.
- Use `npm run ci` as the standard local CI command. It must pass before committing code changes.
- After completing a feature change or bugfix, run the appropriate verification, review the diff, stage only related files, and create a focused git commit unless the user explicitly asks not to commit.
- When adding behavior, include a brief verification note or test command when practical.
