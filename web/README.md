# Archivist Website

The frontend of Archivist's website, built with React, Vite, and Tailwind into `build/web/`. The bot's web listener serves it, along with the JSON routes in [`src/archivist/web/`](../src/archivist/web/README.md). It follows the prototype the owner approved, recorded in the plan's prototype review decisions.

| Path | Contents |
| --- | --- |
| `index.html` | The page every address loads. The server adds a `<base>` tag for the path the website lives under |
| `src/main.tsx`, `src/App.tsx` | Sign-in, choosing an archive, and the archive's shared state |
| `src/Shell.tsx` | The top bar, the place and character columns, the account menu, search, and windows over the page |
| `src/views/` | One file per view: timeline, album, places, graph, heatmap, board, and the character page |
| `src/modals/` | Windows such as an artifact's details, adding an artifact, filters, the calendar, and place editing |
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

The timeline's lane order, hidden lanes, zoom, and marker layers, the album's sort and tile size, and the last archive and timeline position are kept in the browser's storage. They change only that viewer's view and are not archive data.

## Places

A server's page shows its artifacts oldest first, with channel filters and a channel-lane view. Group chats show the same historical list. Channel lanes group artifacts by day, week, or month to keep dots apart. They draw up to the first 2,000 matching artifacts and state when that limit is reached. The paged list retains access to every matching artifact.

Edit Place changes the base name, Discord ID, lane color, dated names, and server icons or the group chat's current icon. It also adds, renames, and deletes a server's channels. Each save checks the current version. A stale save reloads the record for review.

## Heatmap

The heatmap shows a selected year's artifacts and event starts in separate monthly calendars. A duration or occurrence window counts once, on its start or earliest possible day. Dashed outlines identify estimates and file dates. Undated artifacts are counted separately. The tray changes the year, cell size, and shared filters. Selecting a day opens the timeline with those filters.
