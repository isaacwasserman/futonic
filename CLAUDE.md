## Comments
Good code requires very few comments. Default to writing no comments at all — well-named identifiers and clear structure should carry the meaning.

Acceptable uses:
- A brief docstring on a function/class when its purpose isn't obvious from its signature.
- A short inline comment flagging something genuinely non-obvious: a hidden constraint, a workaround for a known bug, a subtle invariant, an ordering requirement.

Do NOT write:
- Block comments narrating design decisions, rationale, or change history on edits. That belongs in the PR description and commit message — not the source file.
- Comments restating what the code already says (`// increment counter` above `counter++`).
- Comments referencing the current task, ticket, or caller (`// added for the X flow`, `// used by Y`) — they rot the moment the code is reused or refactored.
- "Removed X" / "Changed Y" tombstones — git history is the source of truth.
- Numbered step comments narrating the procedure (`// 1. fetch user`, `// 2. validate`, `// 3. save`) — these are tombstones for your own thought process; the code's structure should make the sequence obvious.
- Multi-paragraph explanations of why one approach was chosen over another.

If a comment is removed and a future reader would still understand the code, the comment shouldn't have been there. If you come across existing comments that violate these rules while working in a file, ask the user whether they can be removed rather than silently deleting them or leaving them in place.

## README
The root `README.md` is canonical. Its "Full walkthrough" section is the feature-complete guide to building an example service with the package; `packages/futonic/README.md` is generated from the root README at build time (copied by `scripts/build.ts` for npm) and is gitignored — never edit it directly. Whenever you add, remove, or change a public-facing feature (a package export, an entry point, the service-definition shape, the client, or codegen), update the root README in the same change so it stays accurate.

Keep the walkthrough the simplest possible guide to a feature-complete example: one cohesive example service that exercises every feature, explained in the fewest words that still work end to end. Prefer runnable code over prose, cut anything a reader wouldn't need to get the example working, and don't let it drift into API reference or design rationale.