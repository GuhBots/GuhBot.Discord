# Archivist Website

The website's server side. It runs inside the bot process, and only the bot owner starts and stops it with `/archivist-admin web`. A bot restart leaves it stopped. The frontend is built separately into `build/web/`, and this server serves it.

| File | Contents |
| --- | --- |
| `settings.ts` | The listener's settings and the check that runs when the owner starts it |
| `listener.ts` | The single listener: start, stop, status, and port-conflict reporting |
| `app.ts` | The HTTP app: error replies, security headers, and the built frontend |

The Discord side, `src/lib/archivist-web.ts`, creates the listener and registers it to close during bot shutdown, before the archive stores close.

## Behavior

* **One listener.** A repeated start reports the running listener, and a repeated stop reports that it is stopped. Starts and stops run one at a time.
* **Failures.** Missing settings, a busy port, or an address the machine does not have are reported to the owner, and the bot keeps running.
* **Stopping.** Requests in progress finish before the listener closes. Discord contributions and saved archive data are unaffected.
* **Errors.** Every error reply is `{code, message, details}` with the status from `src/archivist/errors.ts`. An unexpected failure is logged by the bot and replies `500` with code `internal_error` and a generic message, never its details.
* **Pages.** Files in `build/web/` are served as they are. A missing file is a `404`, and every other page gets `build/web/index.html`, the single-page app. Until the frontend is built, pages show a short notice.

## Tests

`npm run test:archivist:web` runs the listener on a free local port. See [Tests](../../../tests/README.md).
