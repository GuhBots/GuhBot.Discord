# Tests

Automated tests, run with the Node.js built-in test runner. `tsconfig.test.json` compiles `src/` and `tests/` together into the ignored `.test-build/` directory, so tests import source files with the same `.js` extensions the bot uses.

## Layout

| Path | Contents |
| --- | --- |
| `archivist/discord/` | The Archivist commands' client: the API transport, uploads, announcement posting and polling, formatting, pending forms, and the server list with its guard and command registration, with Discord and the Archivist service replaced by stand-ins |

## Running Tests

Run the commands from the repository root.

| Command | Purpose |
| --- | --- |
| `npm run test:archivist:discord` | Compile the tests and run the Archivist command suite |
| `npm run build:tests` | Compile the tests into `.test-build/` without running them |

`npm run check` also type checks the tests.

Tests create their own temporary databases and folders and never read `.env` or `data/`. Name test files `<subject>.test.ts`.
