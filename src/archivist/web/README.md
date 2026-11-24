# Archivist Website

The website's server side. It runs inside the bot process, and only the bot owner starts and stops it with `/archivist-admin web`. A bot restart leaves it stopped. The frontend is built separately into `build/web/`, and this server serves it.

| File | Contents |
| --- | --- |
| `settings.ts` | The listener's settings and the check that runs when the owner starts it |
| `listener.ts` | The single listener: start, stop, status, and port-conflict reporting |
| `app.ts` | The HTTP app: the base path, error replies, security headers, the same-origin check, and the built frontend |
| `auth.ts` | Discord sign-in and sign-out, the signed-in contributor (`requireActor`), and `/api/me` with its preferences |
| `sessions.ts` | Sessions and sign-in states in the bot database, stored as token hashes |
| `read-routes.ts` | Read routes under `/api/archives`: archives, places, artifacts, events, entities, requests, the board, and search |
| `change-routes.ts` | Routes that change an archive: entities and their history, merge, artifacts, events, requests and their buckets, the board, and the date preview |
| `intake-routes.ts` | Adding artifacts from the website (upload or Drive link), duplicate review, entity picture uploads, and the logs channel |
| `media-routes.ts` | Media originals and previews, with byte ranges, and the edit-log download |
| `reviews.ts` | Duplicate reviews waiting for the contributor's choices, in memory for 15 minutes |
| `view-routes.ts` | The timeline, calendar, heatmap, and graph data |
| `discord-oauth.ts` | Discord's OAuth endpoints over plain HTTPS: the sign-in link, code exchange, identity, and token revocation |

The Discord side, `src/lib/archivist-web.ts`, creates the listener and registers it to close during bot shutdown, before the archive stores close. It also passes in the pieces that need the bot: owner checks, announcing web uploads in the logs channel, and checking a channel chosen for announcements.

## Behavior

* **One listener.** A repeated start reports the running listener, and a repeated stop reports that it is stopped. Starts and stops run one at a time.
* **Failures.** Missing settings, a busy port, or an address the machine does not have are reported to the owner, and the bot keeps running.
* **Stopping.** Requests in progress finish before the listener closes. Discord contributions and saved archive data are unaffected.
* **Errors.** Every error reply is `{code, message, details}` with the status from `src/archivist/errors.ts`. An unexpected failure is logged by the bot and replies `500` with code `internal_error` and a generic message, never its details.
* **Sign-in.** `/auth/discord` sends the browser to Discord with a one-time state that must come back to the same browser within ten minutes. The callback exchanges the code, reads who signed in, revokes Discord's token, and sets a signed, HttpOnly session cookie that lasts seven days from sign-in. Owner status is asked again at most every five minutes. `POST /auth/logout` ends the session.
* **Changes.** Requests other than `GET`, `HEAD`, and `OPTIONS` must carry the website's own Origin, so another site cannot make changes on someone's behalf.
* **Base path.** Everything lives under the path of `ARCHIVIST_BASE_URL`, such as `/archivist`, including cookies and the sign-in callback.
* **Independence.** Nothing here imports the Discord bot. A core test enforces it, so the website can later run as its own service. See the plan's service boundary section.
* **Pages.** Files in `build/web/` are served as they are. A missing file is a `404`, and every other page gets `build/web/index.html`, the single-page app. Until the frontend is built, pages show a short notice.

## Tests

`npm run test:archivist:web` runs the listener on a free local port. See [Tests](../../../tests/README.md).
