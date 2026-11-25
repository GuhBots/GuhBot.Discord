# Coding Style

These conventions apply throughout the repository, except to vendored or generated files. Add language-specific rules in the section below as languages are introduced. The root `.editorconfig` applies shared encoding, line-ending, and whitespace settings in editors that support it. Add each language's indentation settings there alongside its rules.

## General Code Conventions

* Write code to be read. Use clear names that describe what a function does or what a value holds.
* Keep responsibilities focused and make dependencies, side effects, and ownership clear.
* Follow the surrounding code's conventions unless the change explicitly updates them.
* Use named constants when a literal's meaning would otherwise be unclear.
* Explain non-obvious decisions, constraints, and tradeoffs in comments. Avoid repeating what the code already says.
* Document public interfaces where callers need to understand inputs, outputs, failure behavior, ownership, or lifetime constraints.
* Use idiomatic language features and the project's chosen formatter when one is configured.

## Prose

This applies to documentation, code comments, and schema comments.

* Write plainly, as you would explain something to a colleague.
* Name who does what and prefer active voice.
* Say a thing once, in the place it belongs, and link to it elsewhere.
* Use the serial (Oxford) comma in lists of three or more items.
* Do not use em-dashes. Avoid colons, semicolons, and en-dashes in prose sentences. Split sentences where needed.
* Colons are fine in headings, labels, and lines that introduce a list or formula.

## Markdown

* Write full lines without hard wrapping at a fixed column width. Break at structural boundaries such as headings, paragraphs, and list items.
* Use spaces rather than tabs. Indent nested list content to align with the parent item's content, normally two spaces for bullets.
* Use one level-one heading for the document title and a consistent heading hierarchy.
* Use title case for headings.
* Capitalize the first word of list items. Preserve the exact spelling of code identifiers.
* Leave a blank line around lists and fenced code blocks.
* Specify a language for fenced code blocks when applicable, and use `text` for directory trees or plain output.
* Use descriptive link text and relative links for files within the repository.

## Diagrams

* Use a diagram when it explains relationships or behavior more clearly than prose.
* Keep editable diagram sources with the document or in an adjacent `assets/` directory.
* Use the project's chosen diagram format. Document rendering instructions when a tool is required.
* Render and inspect new or changed diagrams. Fix overlapping labels, unclear arrows, and unreadable layouts.
* Keep labels short and put detailed conditions or explanations in the surrounding text or tables.

## Language-Specific Rules

### TypeScript

These rules cover `src/`. [src/README.md](../src/README.md) explains its layout.

* **Formatting:** Prettier formats the code, configured in `.prettierrc.json`. `npm run format` applies it and `npm run check` verifies it. `.prettierignore` leaves Markdown and the template's YAML and dev container files to their own conventions.
* **Type checking:** `tsconfig.json` enables strict mode and reports unused code. `npm run check` runs the type checker.
* **Modules:** The project uses ECMAScript (ES) modules. Import local files with a `.js` extension, as Node.js requires, even though the source file ends in `.ts`.
* **Naming:** Use `camelCase` for functions and values, `PascalCase` for classes and types, and `UPPER_SNAKE_CASE` for module-level constants. Name files in lowercase with hyphens.
* **Commands:** Group commands by /help category, one discordx class per file. Read settings from `config.ts`, never from `process.env` directly.
* **Errors:** Let unexpected errors propagate. The handler in `main.ts` logs them and replies with an error embed. Catch errors only where the bot can recover, such as when a member has closed their direct messages.
* **Tests:** Archivist has automated tests in `tests/`, which [Tests](../tests/README.md) describes. Other commands have no automated tests. Verify their changes by running the bot against a test server, as [Discord Setup](guides/discord-setup.md) describes.

Add a subsection for each further language the repository uses.

Each subsection should state the following, where applicable.

* The files and components it covers, including explicit exceptions.
* Naming, formatting, imports, and file organization conventions.
* Expectations for public interfaces, comments, error handling, and resource management.
* Testing conventions and links to the relevant verification instructions.
* The formatter, linter, or other checks actually configured, and where to find their configuration.

Keep short language rules here. If they grow into separate documents, link them from this section. Component-specific guidance may extend these rules and must name any exceptions explicitly.
