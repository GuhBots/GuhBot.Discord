# Tests

Automated tests, run with the Node.js built-in test runner. `tsconfig.test.json` compiles `src/` and `tests/` together into the ignored `.test-build/` directory, so tests import source files with the same `.js` extensions the bot uses.

## Layout

| Path | Contents |
| --- | --- |
| `archivist/core/` | Archivist storage, migrations, and shared rules, tested against temporary databases and folders |
| `archivist/helpers/` | Shared test helpers, such as temporary directories that are removed after each test |

## Running Tests

Run the commands from the repository root.

| Command | Purpose |
| --- | --- |
| `npm run test:archivist:core` | Compile the tests and run the Archivist core suite |
| `npm run build:tests` | Compile the tests into `.test-build/` without running them |

`npm run check` also type checks the tests.

Tests create their own temporary databases and folders and never read `.env` or `data/`. Name test files `<subject>.test.ts`.
