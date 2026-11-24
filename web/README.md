# Archivist Website

The frontend of Archivist's website, built with React, Vite, and Tailwind into `build/web/`. The bot's web listener serves it, along with the JSON routes in [`src/archivist/web/`](../src/archivist/web/README.md). It follows the prototype the owner approved, recorded in the plan's prototype review decisions.

| Path | Contents |
| --- | --- |
| `index.html` | The page every address loads. The server adds a `<base>` tag for the path the website lives under |
| `src/main.tsx`, `src/App.tsx` | Sign-in, choosing an archive, and the archive's shared state |
| `src/Shell.tsx` | The top bar, the place and character columns, the account menu, search, and windows over the page |
| `src/views/` | One file per view: timeline, album, places, graph, heatmap, board, and the character page |
| `src/modals/` | Windows such as an artifact's details, adding an artifact, filters, and the calendar |
| `src/components/` | Pieces several views share, such as pictures, pickers, and typed dates |
| `src/api.ts` | Calls to the website's own routes. Response types come from the server code |
| `src/router.ts` | Addresses under the base path, such as `/a/<archive>/album` |
| `src/styles.css` | The approved prototype's styles: flat, dark, and responsive |

## Building

`npm run build` compiles the bot and then this frontend. To build only the frontend:

```sh
npx vite build --config web/vite.config.ts
```

`npm run check` type checks it with `web/tsconfig.json`.

## Trying It Without Discord

[`tests/archivist/e2e/serve.ts`](../tests/archivist/e2e/serve.ts) serves the built website on a made-up archive and prints session cookies, so a browser can sign in without Discord:

```sh
npm run build && npm run build:tests
node .test-build/tests/archivist/e2e/serve.js 3100 /archivist
```

Set the printed `member` or `owner` value as the `archivist_session` cookie for `127.0.0.1`, then open the printed address.

## Per-Viewer Settings

The album's sort and tile size, and the last archive and timeline position, are kept in the browser's storage. They change only that viewer's view and are not archive data.
