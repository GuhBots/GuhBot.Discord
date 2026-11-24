# Archivist Plan

**Status:** Approved. Implementation is pending. This is the canonical plan for the complete Archivist build.

## Purpose And Scope

Preserve the history of a Discord community using original media, historical identities, and events in independent, portable archives. Build the complete hosted Archivist inside this repository, with Discord as the primary contribution interface and equivalent contributor operations in the web app. Include the horizontal timeline, album, object browser, character graph, research board, and heatmap.

The separate standalone viewer is outside this build. Its future reader must be able to interpret an exported archive without GuhBot, its operational database, credentials, or the original media host.

Keep this file at `docs/proposals/ARCHIVIST-PLAN.md` and do not create a competing plan. [Claude Working Instructions](../../CLAUDE.md) describe the development workflow for this build.

### Contract And Agent Rules

* Follow repository instructions, [Contributing](../../CONTRIBUTING.md), [Coding Style](../coding-style.md), and [Documentation](../documentation.md).
* Accepted product rules are requirements. The field, interface, and operational details below make them concrete for final review. Do not silently change them during implementation.
* Complete implementation milestones autonomously once the complete build is authorized. Milestones are internal steps, not permission gates for each ordinary edit.
* Report a genuine incompatibility or external blocker with the affected requirement and a concrete alternative. Do not reopen a settled preference because another implementation is easier.
* Keep archive behavior behind shared application operations. Discord and web adapters must enforce the same validation, authorization, dates, duplicate review, logging, and deletion rules.
* Keep unrelated bot behavior and AFK data intact. Use a feature branch and the repository's normal review workflow.
* Mark milestones complete only after their acceptance checks pass. Report checks that could not run and why.

### Requirement Index

| ID | Accepted Requirement |
| --- | --- |
| `R01` | One original file per artifact, required description, optional character and date overrides, and source-based duplicate reuse with reviewed changes |
| `R02` | Characters separate from accounts, independent identities inside each archive, and artifacts linked to multiple characters and events |
| `R03` | Exact occurrence, estimated occurrence, then embedded original file metadata as date precedence |
| `R04` | Owner-created named archives with explicit archive selection, a remembered last selection in Discord, and independent local folders |
| `R05` | Optional web listener started and stopped only by the bot owner |
| `R06` | Discord sign-in and per-archive whitelist access, with automatic owner access |
| `R07` | Events require title, description, and date information, but may lack evidence |
| `R08` | Complete-folder zip export including media, previews, retained files, and edit logs |
| `R09` | All five hosted research and browsing views |
| `R10` | Discord-inspired flat dark design, a Nerd Font, no gradients, and no shadows |
| `R11` | Automated Archivist checks in CI and representative manual integration checks |
| `R12` | Owner-only whitelist management in `guhbot.db` and access removal on the next request |
| `R13` | Public Google Drive original-file links from contributors' own folders, without folder registration or Google user login |
| `R14` | Permanent record deletion, reference blockers, retained media, no trash, and no deletion log |
| `R15` | Lightweight per-archive edit logs with before and after values, removing a deleted record's own entries |
| `R16` | Every contributor operation on the web, with uploads and quick edits also in Discord. Detailed history editing and character merge are web-only |
| `R17` | Personal timezone and date-order preferences in `guhbot.db`, without shifting date-only values or rewriting history |
| `R18` | Missing-media requests require temporal information, a character, and a description, with no assignees |
| `R19` | Contributor-configured per-archive upload announcements that remain unchanged after edits or deletion |

## Existing Repository And Build Structure

[Archivist](../../src/commands/archivist.ts) currently replies with `WIP`. [Module loading](../../src/modules.ts) already restricts its commands to `ARCHIVIST_GUILD_IDS`. [The SQLite helper](../../src/lib/database.ts) currently stores AFK state. There is no Archivist application, schema, migration system, or automated application test suite yet.

Preserve these boundaries. Contributor commands register only in the existing enabled Archivist guilds. Owner administration registers only in `OWNER_GUILD_ID`, with the existing application-owner guard. Application team members count as owners under that existing rule. Historical servers in an archive need not be guilds the bot currently belongs to.

| Planned Location | Responsibility |
| --- | --- |
| `src/commands/archivist.ts` | Contributor Discord interactions, including the two standalone channel commands |
| `src/commands/archivist-admin.ts` | Owner-only archive, whitelist, and web lifecycle administration, guarded like the commands in `src/commands/owner.ts` and loaded only with the Archivist module |
| `src/archivist/` | Shared operations, stores, validation, dates, media intake, exports, and optional web server |
| `src/archivist/migrations/` | Ordered archive migrations and operational additions to the bot database |
| `web/` | React, Vite, and Tailwind frontend, built into `build/web/` |
| `tests/archivist/` | Core, adapter, route, browser, and fixture coverage |
| `assets/fonts/` | Bundled font files and their license notices |

These are planned directories. Add their required READMEs and parent navigation when implementing them. Do not describe them elsewhere as existing tooling before they exist.

## Storage, Identity, And Permissions

### Filesystem Contract

```text
<DATA_DIR>/
  guhbot.db
  archives/
    <archive-id>/
      archive.db
      edits.log
      media/
        originals/<media-id>.<extension>
        previews/<media-id>.webp
  archivist-tmp/
  archivist-exports/
```

Use generated stable archive IDs as directory names. Archive display names contain 1 to 100 non-blank characters and are unique ignoring case within the installation. Uniqueness uses a stored key that folds Unicode case and compatibility forms, because SQLite's `NOCASE` folds only ASCII. Registering an archive whose name is already taken is rejected, and the owner supplies a new display name. Renaming never moves a folder. All stored media paths are relative to that archive folder. Reject paths that escape it. No archive depends on another archive's records or media.

The portable folder contains historical data and its schema version, original and derived media, and the edit log. Operational registry, whitelists, sessions, personal timezone preferences, remembered archive selections, API keys, pending interactions, delivery tracking, and temporary jobs stay outside it. The operational database extends the current `guhbot.db` without changing AFK records.

Owner registration of an existing archive checks its ID, schema version, file paths, and media references. It does not import an old whitelist. Unregistration removes its operational access and lookup configuration but preserves the folder. Do not add a recursive whole-folder erase command. Independent archive copies may diverge. Cross-copy synchronization and archive merging are excluded.

### Permission Matrix

An archive member means a Discord user currently whitelisted for that archive. Bot owners do not need whitelist entries.

| Operation | Owner | Archive Member | Other User |
| --- | --- | --- | --- |
| View, submit, edit, link, merge characters, and delete permitted archive records | Yes | Yes | No |
| Add and manage research requests, review gaps, and flag disputed claims | Yes | Yes | No |
| Read edit log and download allowed media | Yes | Yes | No |
| Export an archive to a zip on the host | Yes | No | No |
| Set or remove that archive's announcement channel | Yes | Yes | No |
| Set personal timezone | Yes | Yes, for self | No |
| Create, rename, register, unregister, and change archive display settings | Yes | No | No |
| Add, remove, or list whitelist members | Yes | No | No |
| Start or stop the optional web app | Yes | No | No |

Store unique membership pairs `(archive_id, discord_user_id)`. Check current owner or membership authorization on every archive request, including media download requests. Discord sign-in alone grants no archive access. Removal takes effect on the next request, including an existing session. An already-running download may finish. Membership in another archive is irrelevant. Refresh owner status at login and at most every five minutes during active requests.

Use seven-day absolute server-side sessions in bot operational storage and provide logout. Discord sign-in requests only the identity access needed for authentication. Use an unpredictable session cookie, same-origin mutation checks, a protected sign-in state value, and session invalidation on logout. Revoke Discord's access token as soon as the identity is read, so Archivist keeps no Discord credentials for anyone. Store only a hash of each session token. Production cookies require HTTPS. Localhost testing supports the configured local callback without pretending it is a public deployment.

## Media Intake And Duplicate Review

### Accepted Sources And Formats

Accept one direct Discord attachment, one web upload, or one publicly readable Drive binary file link per submission. Accept images (`.jpg`, `.jpeg`, `.png`, `.webp`, and `.gif`), videos (`.mp4`, `.mov`, `.webm`, `.mkv`, and `.avi`), and audio (`.mp3`, `.m4a`, `.wav`, `.ogg`, and `.flac`), up to 104,857,600 bytes per original. Only still images get a generated preview. Videos and audio are shown by kind and file name, and a browser that cannot play a format offers the original for download. Discord's own upload limits also apply. Validate actual file format rather than trusting the name. Do not transcode originals or infer characters or dates from image text automatically.

Preserve received original bytes unchanged, including embedded metadata. Generate previews separately. Preview failure uses a placeholder and does not invalidate the original. Failed original preservation creates no completed artifact or metadata-only draft. Return an actionable retry error. Temporary partial files are not archive records and are cleaned after failure or expiry.

Exclude arbitrary website downloads, Google Photos share-page import, Picker, Discord message-link import, batch folder import, automatic folder synchronization, and automatic replacement of archived original media. A new submission must contain a non-blank description. Characters and occurrence-date overrides may be added later. Relationships supplied at intake must reference existing records in the selected archive. Intake does not create characters or other entities.

### Public Drive Contract

Contributors may use unrelated public Drive folders. No shared folder, source allowlist, folder registration, service-account invitation, or contributor Google sign-in is required. Submit the individual file link, not a folder link. Support file-view links, `open?id=...`, and `uc?id=...`, extracting the file ID and any supplied `resourcekey`.

Without an API key, download from Google's public download address, `https://drive.usercontent.google.com/download`, with the file ID, `export=download`, `confirm=t` to skip the large-file virus-scan notice, and any `resourcekey`. A first request for one byte reads the file name, type, and total size from the response headers, so unsupported and oversized files are refused before downloading. An HTML response or a redirect to a sign-in page means the file is not publicly downloadable or Google is limiting it. The owner chose this on 2026-11-23 so Drive links need no Google setup. It is not a documented Google API and may change or be throttled.

When `GOOGLE_DRIVE_API_KEY` is set, use the Drive API metadata endpoint and binary `files.get` download with `alt=media` instead, not previews or thumbnails. Google's [download guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads) documents the binary content operation. Google documents [public-folder API-key access](https://developers.google.com/workspace/drive/api/guides/search-files) and [resource-key headers](https://developers.google.com/workspace/drive/api/guides/resource-keys). A deployment may provide the API project and key. The key stays server-side and outside archive exports.

Attempt public access only. Preserve the resource key and supply it where required. Reject private, non-downloadable, missing, trashed, oversized, unsupported, native Google document, shortcut, and folder targets. Never parse web pages for links or initiate private-file authorization. Reject inaccessible links with attachment and upload alternatives.

Save original source link, provider, and stable file ID. Do not trust arbitrary redirects or contributor-supplied download hosts. Read accepted embedded capture and creation tags from the downloaded file. Drive `createdTime`, upload time, modified time, and download response dates never supply the default artifact date. The [Drive metadata reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) distinguishes file dates and image metadata. It cannot recreate metadata removed before upload.

A live rehearsal with known files, with and without an API key, remains an external verification prerequisite, not an unanswered product choice. Test image and video originals from two unrelated public folders, including resource-key links, while the web listener is stopped. Verify downloaded bytes and embedded metadata against the supplied originals.

### Source Identity And Review

Duplicate identity is the provider and source item inside the selected archive. Use the Drive file ID, the Discord attachment ID, or a new generated upload ID for each local web upload. Link variants for the same Drive file are one source. Resource keys and tracking parameters do not create new identity. Do not match artifacts by bytes or visual similarity. Store a content hash only for integrity checks.

When a source already exists, return its stable artifact ID and show changed scalar metadata side by side. The contributor selects replacements and relationship additions. Omitted inputs leave values unchanged. Do not silently remove links. Do not replace original media. Cancel, expiry, denied access, or stale review makes no change. An identical submission creates no edit-log entry or new announcement. Resubmission after permanent record deletion creates a new artifact ID, even when older media files remain on disk.

Bind review state to user, archive, and current record version. Expire it after 15 minutes. On apply, recheck access and version. If another edit intervened, show the latest differences and require a fresh choice. Enforce source uniqueness under concurrent submissions so only one active artifact wins.

## Dates And Timezones

### Artifact Dates

Store these values separately and retain provenance. Selection order is fixed.

| Order | Value | Rule |
| --- | --- | --- |
| 1 | Exact occurrence | Exact calendar day or known-offset timestamp. No written basis is needed |
| 2 | Estimated occurrence | One approximate calendar day with a required explanation, visibly labeled estimated |
| 3 | Original file capture or creation | Accepted embedded metadata from the original bytes, never filesystem-copy, upload, Drive, or import time |
| 4 | None | Undated section, search results, and missing-information board |

An exact date needs no moderator approval and no written basis. Clearing an override restores the next available value. Do not destroy lower-precedence values. A file-date-only artifact is complete enough unless someone explicitly flags its date for research. It must still be labeled file metadata rather than verified occurrence.

Use original-capture tags first and embedded creation tags second. Within a priority, conflicting or malformed dates require manual review rather than guessing. Metadata extraction must not fall back to filesystem tags. Record raw tag names and values. The reader reports known offset, calendar-only, or unknown source timezone distinctly.

### Event Dates

Require title, description, and at least an estimated start or estimated range. An exact day or timestamp is also valid and needs no written basis. The description is sufficient context for an event estimate. Do not require a separate explanation. Evidence is optional at creation.

One event has a single date, a duration, or an occurrence window. Ranges include both calendar bounds and must end on or after their start. Duration means the event lasted across the range. Occurrence window means it happened somewhere inside the bounds. Store and display these meanings separately. No nested uncertainty intervals on duration endpoints in this release. For a single-date event, its effective end equals its start.

Linking an artifact never silently supplies or changes an event date. An event with no artifacts displays `No supporting artifacts` and gains a gap card. Linking evidence clears that gap. Removing the last supporting link reopens it. Evidence presence does not prove every claim. Contributors may separately mark a claim disputed with a reason.

### Personal And Archive Timezones

The owner sets the archive timezone, initially `America/Toronto`. Contributors set their own named timezone in `guhbot.db`. A manual date and time without an explicit zone uses the contributor preference, falling back to the archive zone, and shows its interpretation before save. An explicit zone or offset wins. Normalize instants for storage while preserving original input and interpretation zone.

Contributors may type dates in common forms: year-month-day numbers, a month name in any position (`Jul 15 2019`, `15 July 2019`, `july, 2019, 15`), or eight digits, with an optional 24-hour or 12-hour time and an optional zone after the time. A date needs its day and a four-digit year. A four-digit year first always means year-month-day. All-number dates with the year last follow the contributor's date order in `guhbot.db`, year-month-day by default. With that default, such a date is accepted only when one reading is a real date or both readings agree, and is otherwise refused with a request to write the month as a word. Every interface shows dates with the month's abbreviated name, such as `Jul 15, 2019`, so no reader misreads the order. Stored values keep the original text.

Date-only exact values, approximate days, and date-only ranges never shift between zones. Imported unknown timezones remain unknown. A preference change never rewrites historical values. Details may show local timestamp equivalents, while timeline days, day filters, server activity, and heatmap buckets use the archive timezone. Reject invalid timezone names and ask for an explicit offset or corrected time for ambiguous or nonexistent daylight-saving times.

## Historical Identities And Relationships

A character is a real person with a required known name. Aliases, real name, birth date, fallback picture, and in-person acquaintance state are optional. Acquaintance state is unknown, yes, or no. Derive age from birth date. Do not store a separate changing age or create a fictional-character type.

A character may have multiple Discord accounts. A human account has at most one current character and may be unlinked. An unlinked account creates a missing-character gap. Track historical account ownership. Bots are accounts marked as bots with separate, potentially multiple character owners and server memberships. A character may have a main account, the account they used most during a period. Record main-account changes as dated observations of the character. The main account must be an account the character owns or owned.

Record dated observations of account names, discriminators, avatars, character aliases, character main accounts, server names, icons, and owners. Unknown observation dates remain unknown. For historical display, use the latest dated observation at or before the selected historical position. If none exists, use a clearly marked fallback, never imply that today's profile is historically verified. A character's historical picture is the avatar of their main account at that position, then their fallback picture, then initials.

Introductions are directed character links with optional dates and multiple introducers. Server membership belongs to accounts, with multiple join and leave intervals. Character membership aggregates its accounts. Do not use one global character join date.

Support guild channels, threads, direct messages, and group chats. Guild channels and threads have a server. Direct messages and group chats do not. Historical servers, channels, and accounts may lack external Discord IDs. Keep depicted locations separate from the submission guild, channel, and message.

Artifacts may reference multiple characters, accounts, servers, channels, and events. Events may reference multiple characters, servers, and channels. All relationships are local to their archive. Character merge is explicit, chooses a survivor, preserves aliases, reassigns links after conflict review, and never auto-merges matching names. Known Discord account IDs are unique inside an archive.

Store a yes/no flag that a character in an artifact is not identified yet. It starts unset. Contributors set it when they know a character in the artifact is unidentified, and clear it once that character is found. Zero linked characters does not by itself mean anyone is unidentified, and linking a character does not prove every character was identified.

## Research Board And Missing Media

This is a research backlog, not workload management. Do not add assignees or work-allocation features. Priorities are critical for unreadable preserved media, high for unidentified characters and missing account links, medium for undated artifacts and events without evidence, and low for explicitly requested profile or location research. Do not generate a task for every blank optional field. An artifact receives a missing-characters card only while its unidentified-characters flag is set.

### Missing-Media Requests

A request may exist before any file is found. Require a non-blank description, at least one involved character, and one supported temporal constraint. A separate title is not required. Derive a short display label from the description. Optional event links and research notes add context.

| Form | Required Input | Meaning |
| --- | --- | --- |
| Approximate day | Calendar day | Around that day |
| Estimated range | Ordered start and end days | Inclusive uncertainty interval |
| Before a date | Boundary day | Strictly earlier than that day |
| Before an event | Same-archive event ID | Strictly earlier than its start |
| After an event | Same-archive event ID | Strictly later than its end, or start for a single-date event |

For an event occurrence window, use earliest and latest possible days as its start and end. Store a stable event reference, not a copied day. Follow later event-date corrections. Block event deletion until every anchored request receives a different supported constraint. This overrides ordinary event-link cleanup. A before-event or after-event request does not need an invented extra numeric estimate.

The initial form takes one temporal constraint. Preserve open bounds and show relative wording. Do not invent a day to place the request on the artifact timeline or heatmap. Request dates and the eventual found artifact's dates are separate assertions. Any involved character and referenced event must belong to the selected archive.

### Bucket Transitions

Bucket moves and the research board are on the website only. Discord is for quick additions and has no board, flag, or bucket commands. New requests start Needed. Contributors may move one to Unrecoverable with a required reason. When evidence is found, explicitly link its artifact and mark the request Resolved, including from Unrecoverable. Contributors may reopen it to Needed when a conclusion was wrong. Preserve the original description and constraint. Unrecoverable means the information remains missing, not verified or complete.

Derived gap cards resolve from underlying data and reopen if the same gap returns. Maintain one card per record, gap kind, and requested field rather than duplicating cards. Retain resolved cards for research history while their subject still exists. Not applicable requires a reason and a field where that state is meaningful. It cannot pretend media or event evidence exists. A manual date-research flag requires a reason.

## Changes, Deletion, And Edit Logs

Every editable parent record has an incrementing version. Reject stale saves and present current differences instead of silently overwriting another contributor. Apply the same rule to duplicate review and relationship edits. Edits to owned aliases and observations use the parent record's version and log identity.

### Deletion Contract

Owners and current archive members may permanently delete permitted records immediately. No trash, retention delay, record restoration, or deletion log. Block character, account, server, and channel deletion while external links remain. Owned aliases and observations are part of the parent and are removed with it after blockers are cleared. Do not automatically delete referencing artifacts or events.

Artifact deletion removes its relationships and derived gap cards, recalculates event-evidence gaps, and preserves original media and previews. Event deletion removes ordinary links and its gap cards, preserving other records, but is blocked while a request uses it as a temporal anchor. Do not add automatic orphan-file cleanup or an orphan-media gallery. Authorized members may still retrieve retained files under archive access controls, and complete exports include them.

Published Discord artifact announcements remain unchanged after edits or deletion. They are external upload-history snapshots. No deletion announcement is sent. Existing exports and independently held copies are unchanged.

### Log Contract And Recovery

Use one structured text entry per successful edit in `edits.log`, with timestamp, editor Discord ID, edited record type and ID, and changed fields with old and new values. Keep no unchanged full-record snapshots and no revision browser or rollback system. Owner and archive members may read and download the log. No rotation in the first release.

When a record is permanently deleted, remove its own earlier edit entries and emit no deletion entry. Other records' log entries remain, even if their old values mention the deleted record. Do not claim global historical-name erasure. Record IDs must not be reused.

Serialize archive mutations. Coordinate database changes and file writes through temporary files and transient internal recovery state. A deletion is not successful until required log removal succeeds. On interruption, finish or undo the pending operation before allowing further writes or exports. Transient recovery state is not a retained deletion audit and is excluded from exports. Never export a half-applied edit or deletion.

## Artifact Replies And Upload History

Reply privately to a Discord submitter with the saved artifact ID, selected date basis, and embed preview. If an archive has a configured destination, also post there for every newly created artifact, including web submissions. Include archive name, artifact ID, description, identified characters, selected date and basis, contributor, and an image preview or appropriate file/video representation. Unidentified characters and unknown dates remain clearly labeled.

Contributors configure one destination per archive using exactly `/set-artifact-logs-channel` and `/remove-artifact-logs-channel`. The setting applies to everyone's new artifacts for that archive. Changing or removing it affects future posts only. The web app offers equivalent contributor controls. Keep destination and delivery state in `guhbot.db`.

Do not post a new announcement for failed intake, duplicate reuse, or an ordinary edit. Never update or remove earlier announcements after edits or deletion. Successful archival does not depend on announcement delivery. Report notification failure separately as saved-but-not-announced and avoid creating a duplicate artifact when retrying notification. The destination must be a sendable guild text channel where the bot can send embeds and required previews. The contributor must be able to view the chosen channel.

## Hosted Views

### Layout And Navigation

The owner's [layout sketch](assets/archivist-layout-sketch.png) shows the intended desktop arrangement. The final app uses the dark design tokens below rather than the sketch's white background.

At desktop width, the app has three columns. The left column lists servers and group chats as round icons. The center holds the current view. The right column lists every character in the archive with their picture and known name. The set of listed characters does not change while browsing the timeline. Pictures and icons follow the timeline position, which is the date at the center of the visible timeline. A character uses their historical picture rule. A server or group chat uses its icon observation in effect at that date. Outside the timeline, pictures use the latest known observation.

Selecting a server or group chat opens its object view. Selecting a character opens their character page. The page shows their known name, aliases, accounts with name and avatar history, main-account history, age, and acquaintance state, followed by their artifacts and events. It offers actions to filter the timeline to that character, open the graph around them, and edit permitted fields.

A top bar holds the archive switcher, view switcher, search, calendar, and account controls. Below the current view, a tray holds that view's actions, such as zoom, filters, layer toggles, and adding an artifact or event. Each view declares its own tray buttons, so the tray can differ between views and gain buttons later. The owner confirms the exact tray contents and the top bar in the prototype review described under [Delivery And Acceptance](#delivery-and-acceptance).

### Shared Search And Filters

Search character and account names and aliases, artifact descriptions, and event titles and descriptions using case-insensitive Unicode-normalized substring matching. No media-text extraction. Filters cover character, account, server, channel, event, media type, date basis, the unidentified-characters flag, and date range. Require every selected category to match and allow any selected value within a category. Keep filters shared across views within an archive. Clearing or switching archives clears incompatible IDs.

Default ordering is oldest first with stable ID tie-breaking. Put undated artifacts in an explicit searchable section rather than inventing dates. Date filters include duration and occurrence-window records whose bounds overlap the selected interval. Restrict graph counts and heatmap counts to the filtered records. Page lists and fetch only the visible timeline window.

### Horizontal Timeline And Calendar

The timeline stacks server and group-chat lanes above an event band and a month/year calendar ruler, with day, month, and year zoom. Dashes mean uncertainty throughout the timeline. Include a calendar modal in the top bar, with day selection moving to that period. Selecting a record opens details with permitted editing.

The owner selects a main server whose lane is always shown, closest to the event band. Every server and group chat has its own solid lane color, assigned automatically from a palette that reads well on the dark theme and editable afterward. A record in a guild channel or thread belongs to its server's lane. Direct messages and records with no known server or group chat use an Unassigned lane. Secondary lanes group filtered activity whose gaps are at most 90 calendar days, disappearing across larger gaps and reappearing with the same identity. The threshold is an archive setting. A lane may be drawn branching from the main lane, but branches do not assert ancestry. Show a record linked to several lanes on each of them with one underlying record ID. Whether a single server's object view shows its channels as lanes is decided in the prototype review.

Artifacts appear as one dot per lane and day. At coarser zoom, a dot covers a week or month. A darker green means more artifacts in that period. A dot with a dashed outline contains at least one artifact whose selected date is estimated or comes from file metadata. Selecting a dot opens a gallery of that period's artifacts in historical order. The gallery shows a large preview, description, characters, and date with its basis, with previous and next controls, a thumbnail strip, and a link to full details. Retain every item in detail and list access.

Ranged events appear in the event band as labeled strips in their event color. Overlapping events are placed in parallel rows so none hides another. A duration is a solid strip, and an occurrence window is a dashed strip. Event colors are assigned automatically from the palette and are editable. Events do not recolor lanes.

Single-day events appear as red downward arrows with their names on their lanes. Several single-day events on one lane and day share an arrow with an expandable count. Server name and icon changes appear automatically as arrows in a separate color showing the new name and icon, because they mark the server's eras. Each lane's label shows the name and icon in effect at the visible position. Account name changes, avatar changes, and character main-account changes form an optional marker layer, off by default. Tray toggles control each marker layer. Estimated events and markers are visibly labeled as estimates.

### Object Browser

Selecting a server or group chat in the left column opens its object view. A server shows its channel navigation beside the left column. The center lists the selected place's artifacts in historical order, not submission order. Dedicated quotes are excluded.

### Character Graph

Characters are nodes. Toggle separate layers for artifact co-occurrence, event co-occurrence, directed introduction, and overlapping server memberships. Count each shared artifact or event once per pair. Membership weight is the number of servers with known overlapping membership. Exclude unknown intervals from overlap counts. Collapse accounts into their character node. Do not invent a composite relationship-strength score. Show the supporting records for a selected connection.

### Heatmap

Count one unit per dated artifact and one per event start or earliest possible occurrence day. Show artifact and event counts separately and identify estimates. Count an event once regardless of duration or lane duplication. Exclude undated artifacts and show their count separately. Clicking a day navigates the timeline using the same filters. Use archive-timezone day buckets for everyone.

### Album

The album shows every visible artifact as square tiles and nothing else, like a photo library. Tiles are grouped under month headings when sorted by date, with undated artifacts in their own section at the end. Contributors sort oldest first, newest first, or most recently added, and choose a small, medium, or large tile size. Shared filters apply. Tiles mark video, audio, unreadable files, and estimated or file-metadata dates. Selecting a tile opens the artifact's full details, with previous and next controls and arrow keys that step through the album in its current order.

### Prototype Review Decisions

The owner reviewed the clickable prototype on 2026-11-23 and approved it after three rounds. These decisions refine the sections above.

* **Top bar.** The product name is GuhBot Archivist. The calendar accepts a typed year, month, or day, such as `2020`, `Jul 2020`, or `Jul 15 2020`. A year opens year zoom on that year, a month opens month zoom, and a day opens day zoom on that day. Impossible dates are refused. The account menu at the top right holds the contributor's timezone and all-number date order, the same preferences Discord sets, and sign-out.
* **Notifications.** Short confirmations, such as a hidden lane, appear at the top middle of the screen.
* **Timeline movement.** Dragging pans the timeline. A mouse wheel or a sideways trackpad swipe moves through time. Ctrl with the wheel, or a trackpad pinch, steps between the zoom levels.
* **Lanes.** Each viewer can reorder lanes by dragging a grip beside the lane name, or with the arrow keys on a focused grip, and hide a lane. Hidden lanes are listed in a Lanes control with a reset. The order and hidden lanes are local to the viewer's browser. They are not archive data and do not change anyone else's view. The main server's lane starts closest to the event band.
* **Markers.** Arrows have a fixed shape that a short lane cannot distort, and labels sit beside their arrow, shortened before the next arrow so text never covers one. The tray legend explains red event arrows and server-change arrows. The character-change layer shows pictures only: a new avatar shows the new picture, and a name or main-account change shows the character's picture at that time. The details are in the tooltip and on the character page.
* **Places.** A server's page switches in the tray between a list and channel lanes. Channel lanes use the timeline's shaded dots, one per period, with the period chosen so dots stay apart. Edit Place opens a dialog for the kind, Discord ID, lane color, dated names and icons, and channels. Names and icons show their actual images where known.
* **Graph.** A deterministic force layout places the nodes. Every pair of characters pushes apart, and each visible connection pulls its pair together in proportion to what the visible layers count for that pair, so groups form by connection. The same data always gives the same picture, with no live simulation. The pull only places nodes; no strength score is shown. Circles grow with their connections, lines are thin, and pointing at a character highlights their connections. The wheel or a pinch zooms around the pointer, dragging pans, and the tray offers zoom out, zoom in, and fit. Selecting a line opens an album of every artifact the two characters share, or the supporting records when they share none.
* **Character page.** Fact labels such as Real name, Birth date, and Met in person are bold, and an unknown value reads "unknown". Account history shows the actual avatar images. Selecting the character's picture opens an album of every picture they have had, oldest first, with each picture's account and start date, then the fallback picture. Animated GIF avatars play as uploaded. They are served as the original file rather than a still preview.
* **Heatmap.** The viewer can zoom the heatmap so its cells are large enough to read and select.
* **Discord IDs.** A Discord ID encodes when its account, server, channel, or message was created. Detail views show that creation date wherever an ID is known, derived without a network request. A contributor may fetch an account's current name and avatar, or a server's current name and icon where the bot can see it, from Discord. A fetch records what Discord returns as an observation dated the day of the fetch. It never backdates a current picture into the past.

## Web Lifecycle, Exports, And Operations

One listener in the bot process serves all allowed archives, the frontend, and backend routes. Only the owner starts and stops it. No automatic start, idle shutdown, hidden Google callback server, or persistent live connections. Repeated start returns current availability. Repeated stop returns stopped state. Bot restart leaves the listener stopped. Stop closes web access without stopping Discord contributions or discarding saved archive data.

### Service Boundary

`src/archivist/` holds the archive rules and the website, and it does not depend on the Discord bot: no Discord library, no bot module, and no environment variables, which `config.ts` reads and passes in. A core test enforces this. The website's Discord sign-in uses plain HTTPS calls to Discord's OAuth endpoints, not the bot's connection, and owner status reaches it through an injected check. The JSON routes are the service's contract and mirror the shared operations one to one.

In this build the service runs inside the bot process and the owner starts it from Discord. The owner noted on 2026-11-23 that adding and editing artifacts feels better on the website than in Discord, and asked to keep a later move possible: the website becoming the source of truth as its own service, possibly in a separate `GuhBot.Archivist` repository, with the Discord bot calling its API. That move is not part of this build. When it happens, the service gets its own entry point and settings, an owner list or a Discord REST lookup replaces the bot's owner check, the Discord adapters call the JSON routes with a service credential that names the acting Discord user, and the in-bot listener commands are retired. Keep new code on the service side of the boundary so the move stays mechanical.

Test on localhost first. Remote deployment uses a configured public address and external HTTPS reverse proxy. Do not build certificate, tunnel, or router automation. Graceful bot shutdown closes the listener and finishes or aborts archive operations consistently. Port conflict or listener-start failure leaves the bot working and reports a useful error.

Only the owner exports, from `/archivist-admin export create`. Create a consistent snapshot under the archive write lock, release it before zip compression, and zip the complete portable folder. Include its database, log, originals, previews, and retained unreferenced media. Exclude operational state, temporary recovery files, secrets, sessions, and other archives. Do not simply copy a live SQLite main file while ignoring pending writes.

Write each zip directly into `archivist-exports/` on the host, outside the portable folder, under a temporary name that becomes the final `.zip` name only when complete. Nothing is sent through Discord or the web app, because archives may reach hundreds of gigabytes. The owner copies the zip off the host and deletes it when done. Archivist never deletes a finished zip. A restart during compression marks the job failed and removes its partial file. Restoring/registering an exported archive for hosting is owner-only and never grants old whitelist access.

## Exact Data Contract

### Shared Field Rules

Use generated stable `crypto.randomUUID()` identifiers for internal records and text for external Discord and Drive IDs. Every archive has independent identity space. Foreign keys inside its database never point into `guhbot.db` or another archive.

A writable parent record has `id`, positive `version`, creation timestamp, creator Discord ID, and update timestamp. Dates of creation and update are zero-offset timestamps. Historical date values are separate. Empty optional text is normalized to null. Required names are 1 to 100 characters, event titles 1 to 200, descriptions 1 to 20,000, and reasons and research notes 1 to 10,000 when supplied. Reject blank required values after trimming. Server, channel, and event colors are lowercase `#rrggbb` values. The application assigns each from a palette at creation, and contributors may change it. Do not silently truncate stored descriptions to Discord embed limits. Truncate only the visible embed text and offer full details.

The schema below fixes column names, storage types, nullability, defaults, uniqueness, foreign keys, and deletion actions. Application validators additionally enforce real calendar dates, timezone rules, cross-field semantics, minimum relationship counts, and permitted target kinds. These validations are shared by both interfaces. A reader validates schema version and treats invalid relationships as archive errors rather than guessing.

`date_values` is an immutable assertion with one value kind. `day` is a calendar date. `instant` is milliseconds since the Unix epoch plus its original text and interpretation timezone. `unknown_local` preserves a source local date and time without inventing an instant. `archive_day` is a derived day cache for queries, not a replacement assertion. Recompute it and dependent date indexes when archive display timezone changes. Such cache maintenance does not invent an edit to historical source data. Remove unreferenced date rows after a successful mutation. Media rows and files remain as already specified.

Artifact `selected_date_id` equals the first non-null exact, estimated, or file date. Exact assertions may use `day` or `instant`. Artifact estimates use `day`. File metadata may use any date kind. Event estimates and all uncertainty windows use calendar days. Check start and end ordering in shared validation, including instant order when both bounds are instants.

History rows and relationship rows are owned or linked data edited through their parent operation. Log them using the affected surviving parent record identity. Character merges reassign both current and historical references, including request characters, bot owners, and main accounts, before deleting the losing character and removing its own earlier log entries. Conflicting current account ownership requires a reviewed choice.

For request creation, validate at least one `request_characters` row (`request_people` before schema version 3) in the transaction before commit. A resolved request must have at least one linked found artifact. Removing the final found-artifact link, including by artifact deletion, reopens a resolved request to Needed. Preserve its original temporal assertion. An event used as `anchor_event_id` cannot be deleted, even if the request is Resolved or Unrecoverable, until that assertion is replaced.

### Embedded Metadata Field Map

Read raw metadata tags using ExifTool without changing originals or inferring timezones from geolocation. Ignore `FileCreateDate`, `FileModifyDate`, `FileAccessDate`, tool execution time, and filesystem directory dates. Do not accept `.png` modification-time tags as creation dates.

| Formats | Original-Capture Priority | Creation Fallback |
| --- | --- | --- |
| `.jpg`, `.jpeg`, `.png`, and `.webp` | Embedded `DateTimeOriginal`, including matching subsecond and original-offset tags, or embedded `DateCreated` | Embedded `CreateDate` with its own matching offset, then a valid embedded creation-time field |
| `.gif` | A recognized embedded original-capture tag if actually present | A recognized embedded creation tag if present, otherwise unknown |
| `.mp4`, `.mov`, and `.m4a` | Embedded `DateTimeOriginal` or offset-bearing media `CreationDate` | Embedded container `CreateDate`, preserving unknown timezone when the source field does not establish one |
| `.webm` and `.mkv` | Matroska `DateUTC`, which is in UTC by definition | None |
| `.avi` and `.wav` | RIFF `DateTimeOriginal` | RIFF `DateCreated` (the `ICRD` chunk) |
| `.mp3`, `.ogg`, and `.flac` | None, because their date tags hold a recording's release date or year | None |

Retain group-qualified raw tag names and values in `metadata_json`. Do not combine an offset from one metadata field with another field's date. If a library normalizes dates, retain raw values so its interpretation can be checked. A known source-standard offset may be used only with that field's documented basis. Malformed dates, same-priority conflicts, and absent dates remain unknown pending explicit correction. Manual historical dates continue to override the metadata default.

### Archive Schema Draft

This is the initial archive schema. It is implemented as migration version 1 in [archive-schema.ts](../../src/archivist/migrations/archive-schema.ts), which must match this block. Additional migrations must update the embedded version and `PRAGMA user_version` together, preserve existing data, and back up before destructive changes. Refuse writes to a newer unsupported schema. Version checks use `>= 1` so later migrations need not rebuild the metadata table. Code refuses versions newer than it supports. There is no automatic downgrade.

```sql
PRAGMA foreign_keys = ON;

PRAGMA user_version = 1;

CREATE TABLE date_values (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('day', 'instant', 'unknown_local')),
  original_text TEXT NOT NULL,
  calendar_day TEXT,
  instant_ms INTEGER,
  local_datetime TEXT,
  timezone TEXT,
  archive_day TEXT NOT NULL,
  CHECK ((kind = 'day' AND calendar_day IS NOT NULL AND instant_ms IS NULL AND local_datetime IS NULL AND timezone IS NULL) OR (kind = 'instant' AND instant_ms IS NOT NULL AND calendar_day IS NULL AND local_datetime IS NULL AND timezone IS NOT NULL) OR (kind = 'unknown_local' AND calendar_day IS NOT NULL AND local_datetime IS NOT NULL AND instant_ms IS NULL AND timezone IS NULL))
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  original_path TEXT NOT NULL UNIQUE,
  preview_path TEXT UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 104857600),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  known_name TEXT NOT NULL CHECK (length(trim(known_name)) BETWEEN 1 AND 100),
  real_name TEXT,
  birth_day TEXT,
  met_in_person TEXT NOT NULL DEFAULT 'unknown' CHECK (met_in_person IN ('unknown', 'yes', 'no')),
  fallback_media_id TEXT REFERENCES media(id) ON DELETE RESTRICT
);

CREATE TABLE character_aliases (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  observed_date_id TEXT REFERENCES date_values(id),
  UNIQUE (character_id, name, observed_date_id)
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'bot')),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  character_id TEXT REFERENCES characters(id) ON DELETE RESTRICT,
  CHECK (kind = 'human' OR character_id IS NULL)
);

CREATE TABLE account_ownerships (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  start_date_id TEXT REFERENCES date_values(id),
  end_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE character_main_accounts (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  observed_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE account_names (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  discriminator TEXT,
  observed_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE account_avatars (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id),
  observed_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE bot_owners (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  PRIMARY KEY (account_id, character_id)
);

CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
);

CREATE TABLE server_names (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  observed_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE server_icons (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id),
  observed_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE server_owners (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  observed_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('guild_channel', 'thread', 'direct_message', 'group_chat')),
  server_id TEXT REFERENCES servers(id) ON DELETE RESTRICT,
  parent_channel_id TEXT REFERENCES channels(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  icon_media_id TEXT REFERENCES media(id),
  color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  CHECK ((kind IN ('guild_channel', 'thread') AND server_id IS NOT NULL) OR (kind IN ('direct_message', 'group_chat') AND server_id IS NULL)),
  CHECK ((kind = 'thread' AND parent_channel_id IS NOT NULL) OR (kind <> 'thread' AND parent_channel_id IS NULL))
);

CREATE TABLE channel_names (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  observed_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  joined_date_id TEXT REFERENCES date_values(id),
  left_date_id TEXT REFERENCES date_values(id)
);

CREATE TABLE introductions (
  id TEXT PRIMARY KEY,
  introducer_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  introduced_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  date_id TEXT REFERENCES date_values(id),
  CHECK (introducer_id <> introduced_id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 20000),
  date_kind TEXT NOT NULL CHECK (date_kind IN ('single', 'duration', 'occurrence_window')),
  certainty TEXT NOT NULL CHECK (certainty IN ('exact', 'estimated')),
  start_date_id TEXT NOT NULL REFERENCES date_values(id),
  end_date_id TEXT REFERENCES date_values(id),
  exact_basis TEXT,
  disputed_reason TEXT,
  color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  CHECK ((date_kind = 'single' AND end_date_id IS NULL) OR (date_kind <> 'single' AND end_date_id IS NOT NULL)),
  CHECK (certainty <> 'exact' OR length(trim(coalesce(exact_basis, ''))) > 0)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  media_id TEXT NOT NULL UNIQUE REFERENCES media(id),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 20000),
  source_provider TEXT NOT NULL CHECK (source_provider IN ('drive', 'discord_attachment', 'web_upload')),
  source_key TEXT NOT NULL,
  source_url TEXT,
  source_resource_key TEXT,
  submission_guild_id TEXT,
  submission_channel_id TEXT,
  submission_message_id TEXT,
  exact_date_id TEXT REFERENCES date_values(id),
  exact_basis TEXT,
  estimated_date_id TEXT REFERENCES date_values(id),
  estimate_reason TEXT,
  file_date_id TEXT REFERENCES date_values(id),
  selected_date_id TEXT REFERENCES date_values(id),
  identification_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK (identification_state IN ('unreviewed', 'incomplete', 'complete')),
  UNIQUE (source_provider, source_key),
  CHECK (selected_date_id IS coalesce(exact_date_id, estimated_date_id, file_date_id)),
  CHECK (exact_date_id IS NULL OR length(trim(coalesce(exact_basis, ''))) > 0),
  CHECK (estimated_date_id IS NULL OR length(trim(coalesce(estimate_reason, ''))) > 0)
);

CREATE TABLE artifact_people (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, character_id)
);

CREATE TABLE artifact_accounts (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, account_id)
);

CREATE TABLE artifact_servers (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, server_id)
);

CREATE TABLE artifact_channels (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, channel_id)
);

CREATE TABLE artifact_events (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, event_id)
);

CREATE TABLE event_people (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  PRIMARY KEY (event_id, character_id)
);

CREATE TABLE event_servers (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  PRIMARY KEY (event_id, server_id)
);

CREATE TABLE event_channels (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  PRIMARY KEY (event_id, channel_id)
);

CREATE TABLE research_requests (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 20000),
  constraint_kind TEXT NOT NULL CHECK (constraint_kind IN ('approximate_day', 'date_range', 'before_date', 'before_event', 'after_event')),
  start_day TEXT,
  end_day TEXT,
  anchor_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'resolved', 'unrecoverable')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  research_notes TEXT,
  unrecoverable_reason TEXT,
  CHECK ((constraint_kind IN ('approximate_day', 'before_date') AND start_day IS NOT NULL AND end_day IS NULL AND anchor_event_id IS NULL) OR (constraint_kind = 'date_range' AND start_day IS NOT NULL AND end_day IS NOT NULL AND end_day >= start_day AND anchor_event_id IS NULL) OR (constraint_kind IN ('before_event', 'after_event') AND start_day IS NULL AND end_day IS NULL AND anchor_event_id IS NOT NULL)),
  CHECK (status <> 'unrecoverable' OR length(trim(coalesce(unrecoverable_reason, ''))) > 0)
);

CREATE TABLE request_people (
  request_id TEXT NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  PRIMARY KEY (request_id, character_id)
);

CREATE TABLE request_events (
  request_id TEXT NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, event_id)
);

CREATE TABLE request_artifacts (
  request_id TEXT NOT NULL REFERENCES research_requests(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, artifact_id)
);

CREATE TABLE gap_cards (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unreadable_media', 'missing_people', 'account_character', 'undated', 'missing_evidence', 'date_research', 'custom')),
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'resolved', 'unrecoverable')),
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  reason TEXT,
  CHECK ((artifact_id IS NOT NULL) + (account_id IS NOT NULL) + (event_id IS NOT NULL) + (character_id IS NOT NULL) + (server_id IS NOT NULL) = 1),
  CHECK (status <> 'unrecoverable' OR length(trim(coalesce(reason, ''))) > 0),
  UNIQUE (kind, artifact_id, field_name),
  UNIQUE (kind, account_id, field_name),
  UNIQUE (kind, event_id, field_name),
  UNIQUE (kind, character_id, field_name),
  UNIQUE (kind, server_id, field_name)
);

CREATE TABLE archive_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  archive_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  main_server_id TEXT REFERENCES servers(id) ON DELETE RESTRICT,
  lane_gap_days INTEGER NOT NULL DEFAULT 90 CHECK (lane_gap_days >= 1),
  colors_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(colors_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX date_archive_day ON date_values(archive_day, id);

CREATE INDEX artifact_selected_date ON artifacts(selected_date_id, id);

CREATE INDEX event_start_date ON events(start_date_id, id);

CREATE INDEX event_end_date ON events(end_date_id);

CREATE INDEX request_anchor ON research_requests(anchor_event_id);

CREATE INDEX request_status_priority ON research_requests(status, priority, id);

CREATE INDEX gap_status_priority ON gap_cards(status, priority, id);

CREATE INDEX artifact_people_reverse ON artifact_people(character_id, artifact_id);

CREATE INDEX artifact_event_reverse ON artifact_events(event_id, artifact_id);

CREATE INDEX artifact_server_reverse ON artifact_servers(server_id, artifact_id);

CREATE INDEX artifact_channel_reverse ON artifact_channels(channel_id, artifact_id);

CREATE INDEX artifact_account_reverse ON artifact_accounts(account_id, artifact_id);

CREATE INDEX event_people_reverse ON event_people(character_id, event_id);

CREATE INDEX event_server_reverse ON event_servers(server_id, event_id);

CREATE INDEX event_channel_reverse ON event_channels(channel_id, event_id);

CREATE INDEX main_account_character ON character_main_accounts(character_id);

CREATE INDEX membership_server ON memberships(server_id, account_id);

CREATE INDEX request_people_reverse ON request_people(character_id, request_id);

CREATE INDEX request_artifact_reverse ON request_artifacts(artifact_id, request_id);
```

Migration version 2 applies the owner's 2026-11-23 rehearsal decisions. Exact dates no longer need a basis, and identification becomes a yes/no flag. SQLite cannot drop a `CHECK` constraint, so it rebuilds `artifacts` and `events` with their data, following SQLite's documented table rebuild with foreign keys off and a full `foreign_key_check` before commit. `exact_basis` stays as a nullable column and keeps earlier values. `identification_state` becomes `unidentified_people`, set to 1 where it was `incomplete`. The other columns, constraints, and indexes are unchanged.

```sql
PRAGMA user_version = 2;

-- artifacts: drop CHECK (exact_date_id IS NULL OR length(trim(coalesce(exact_basis, ''))) > 0)
-- artifacts: replace identification_state with
unidentified_people INTEGER NOT NULL DEFAULT 0 CHECK (unidentified_people IN (0, 1))

-- events: drop CHECK (certainty <> 'exact' OR length(trim(coalesce(exact_basis, ''))) > 0)
```

Migration version 3 applies the owner's 2026-11-23 terminology decision to say "character" rather than "people". The three link tables and their reverse indexes, the artifact flag column, and one board card kind are renamed. `gap_cards` is rebuilt the same way as in version 2, because its kind list is a `CHECK` constraint. Every row is kept. Edit-log lines written before version 3 keep the old field names `people` and `unidentifiedPeople`, since the log is never rewritten.

```sql
PRAGMA user_version = 3;

ALTER TABLE artifact_people RENAME TO artifact_characters;
ALTER TABLE event_people RENAME TO event_characters;
ALTER TABLE request_people RENAME TO request_characters;
-- each *_people_reverse index is recreated as *_characters_reverse
ALTER TABLE artifacts RENAME COLUMN unidentified_people TO unidentified_characters;

-- gap_cards: kind 'missing_people' becomes 'missing_characters'
```

### Operational Schema Draft

Apply this additive migration in `guhbot.db`. Preserve the existing AFK table and its values. Use `archivist_schema` for this feature's operational migration version instead of claiming ownership of the whole database's version. Pending form data and staged upload tokens expire after 15 minutes and may live in memory. A bot restart invalidates those pending actions, not saved archive data or unexpired server-side login sessions.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE archivist_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= 1)
);

CREATE TABLE archivist_archives (
  archive_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL,
  registered_by TEXT NOT NULL
);

CREATE TABLE archivist_whitelist (
  archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (archive_id, discord_user_id)
);

CREATE TABLE archivist_timezones (
  discord_user_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE archivist_last_archives (
  discord_user_id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);

CREATE TABLE archivist_sessions (
  token_hash TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  owner_checked_ms INTEGER,
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  CHECK (expires_ms > created_ms)
);

CREATE TABLE archivist_auth_states (
  token_hash TEXT PRIMARY KEY,
  expires_ms INTEGER NOT NULL
);

CREATE TABLE archivist_announcement_channels (
  archive_id TEXT PRIMARY KEY REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  configured_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE archivist_announcements (
  archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'indeterminate')),
  attempted_at TEXT,
  error_code TEXT,
  PRIMARY KEY (archive_id, artifact_id)
);

CREATE TABLE archivist_export_jobs (
  id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES archivist_archives(archive_id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'expired')),
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER,
  relative_path TEXT,
  error_code TEXT
);

CREATE INDEX archivist_membership_user ON archivist_whitelist(discord_user_id, archive_id);
CREATE INDEX archivist_session_expiry ON archivist_sessions(expires_ms);
CREATE INDEX archivist_export_expiry ON archivist_export_jobs(expires_ms);
```

Operational migration version 2 adds each contributor's date order.

```sql
CREATE TABLE archivist_date_orders (
  discord_user_id TEXT PRIMARY KEY,
  date_order TEXT NOT NULL CHECK (date_order IN ('ymd', 'mdy', 'dmy')),
  updated_at TEXT NOT NULL
);
```

Operational migration version 3 adds the signed-in contributor's Discord name and avatar address to each session, for the website's account menu. They come from Discord at sign-in and are not archive data.

```sql
ALTER TABLE archivist_sessions ADD COLUMN display_name TEXT;
ALTER TABLE archivist_sessions ADD COLUMN avatar_url TEXT;
```

## Command And Interface Contract

### Discord Commands

Every contributor operation selects an archive and checks current access. In Discord, the archive option may be omitted. The command then uses the archive the contributor last selected explicitly in a contributor command that passed its access check. If none is remembered or access to it has been removed, the command requires a selection. Every reply names the archive used. Web routes always name the archive in the path. Use paginated choices where Discord cannot display every record. Defer private replies before network or disk work. Bind confirmation forms and duplicate reviews to the original user, archive, and record version, expiring after 15 minutes. Reject actions from another user or an expired form. One intake creates or reviews one artifact. Bulk forms are excluded.

Owner commands use `/archivist-admin` in `OWNER_GUILD_ID` to preserve the existing owner-command registration boundary. Contributor groups use `/archivist` in enabled Archivist guilds, and `/a` registers the same groups as a short alias. The optional archive option is the last option of every contributor command. The two artifact-log commands retain the exact standalone names requested by the owner.

| Command Or Group | Inputs And Result |
| --- | --- |
| `/archivist-admin archive create` | Required name. Create its database and folder and return stable ID and name. Main server may be selected afterward |
| `/archivist-admin archive rename` | Archive, new name, and optionally the version last seen. Rename without moving files. Owner commands default to the current version because only the owner runs them |
| `/archivist-admin archive register` | An existing archive ID under the managed archive root. Validate and register it. Do not accept arbitrary filesystem paths |
| `/archivist-admin archive unregister` | Archive. Explicit confirmation removes operational registration and access settings, preserving files |
| `/archivist-admin archive settings` | Archive and current version. Edit main server, timezone, positive lane-gap days, and display colors |
| `/archivist-admin whitelist add` | Archive and Discord user. Add idempotently |
| `/archivist-admin whitelist remove` | Archive and Discord user. Remove idempotently, effective on next request |
| `/archivist-admin whitelist list` | Archive. List every entry with pagination and an empty state |
| `/archivist-admin export create`, `list` | Archive for create. Take a consistent snapshot, write the zip on the host, and report its path, size, or failure. List recent exports with their state and whether the zip is still on disk |
| `/archivist-admin web start`, `stop`, `status` | Global listener control and availability |
| `/archivist archive list` | List only accessible archives, or all for the owner |
| `/archivist artifact add` | Archive, description, and exactly one attachment or Drive file link. Optional dates and links to existing records. Return saved record or duplicate review |
| `/archivist artifact show`, `edit`, `delete` | Archive and artifact ID. Edit requires current version. Delete follows confirmation and cleanup rules |
| `/archivist entity create`, `show`, `edit`, `delete` | Archive, entity kind, and ID where relevant. Kind is character, account, server, or channel. A bot is an account kind. Edit changes a record's own fields, such as names, Discord ID, linked character, place, and lane color. Delete reports what still links to the record before showing the confirmation. Dated history and character merge are edited on the website |
| `/archivist event create`, `show`, `edit`, `delete` | Archive, event fields or ID, and current version for mutation. Enforce date and anchor blockers. Check delete blockers before showing the confirmation |
| `/archivist request create`, `show`, `edit` | Archive and missing-media request fields or ID. Creation requires description, characters, and temporal constraint |
| `/archivist preferences show`, `timezone`, `date-order`, `reset` | Self-service named timezone and all-number date order. Reset clears both, falling back to the selected archive timezone and year-month-day |
| `/set-artifact-logs-channel` | Required archive and optional channel, defaulting to current channel. Configure one destination for all new artifacts in that archive |
| `/remove-artifact-logs-channel` | Required archive. Remove future delivery setting, preserving old messages |

The owner approved this intake flow on 2026-11-23.

* **Characters.** One `characters` field takes names separated by commas, with autocomplete suggesting the next name. Names match a character's known name or alias. A name that matches several characters, or none, is refused with a message naming it. Autocomplete then offers the characters with their short IDs, such as `Alex (3f9a1c2e)`. Contributors add more characters, and the events the artifact shows, from the reply.
* **Dates.** Separate `exact_date`, and `estimated_day` with `estimate_reason`, fields. An exact date needs no basis. An estimate needs its reason. With neither, the file's own date is used.
* **Reply.** A private reply names the archive and the artifact's short ID, then shows the description, characters, the selected date with its basis, and a preview. It has Edit, Add characters/events, Someone unidentified, and Delete buttons. Someone unidentified sets the unidentified-characters flag and then reads Everyone identified, which clears it. Delete asks for confirmation.
* **Short IDs.** Replies show the first eight characters of a record ID. Every command accepts any unique prefix of at least eight characters, and asks for more when a prefix matches several records.
* **Duplicate review.** Nothing is saved until the contributor ticks the differences to apply, then confirms. It lists replaced fields with their current and new values, and links to add. Unticked items are left alone, links are only added, and the original file is never replaced.

Show full details and edit forms with controls appropriate to Discord limits. Use a preview and continuation controls for long descriptions rather than dropping required data. All contributor operations have web controls with equivalent validation and outcomes. Dated history (aliases, account names and avatars, main accounts, ownership, bot owners, server names, icons, and owners, channel names, memberships, and introductions) and character merge are edited only on the website, where the whole record is visible. Owner administration does not require a web administration panel.

### Web Routes

Serve frontend and backend from the same origin. Prefix archive routes with `/api/archives/:archiveId`. Validate access before loading records or touching media. Do not accept the actor identity, internal paths, calculated date basis, creator, version increments, or log contents as client-controlled fields.

| Route | Contract |
| --- | --- |
| `GET /auth/discord`, `GET /auth/discord/callback` | Sign-in start and registered callback with state validation |
| `POST /auth/logout` | Invalidate session and clear cookie |
| `GET /api/me`, `PUT /api/me/timezone`, `PUT /api/me/date-order`, `DELETE /api/me/preferences` | Current identity and self-service timezone and date order. Delete resets both, as the Discord reset does |
| `GET /api/archives` | Accessible archive summaries only |
| `GET /api/archives/:archiveId` | Archive metadata and display settings |
| `GET /artifacts`, `GET /artifacts/:id` | Paged filtered list, sorted oldest first, newest first, or most recently added, or full details |
| `POST /artifacts/intake` | Multipart upload or a public Drive file link and description, with optional metadata. Return new artifact or a review token and differences |
| `POST /artifacts/reviews/:token/apply` | Selected scalar replacements and relationship additions, with expected version |
| `PATCH /artifacts/:id`, `DELETE /artifacts/:id` | Validated edit or permanent deletion with expected version |
| `GET`, `POST`, `PATCH`, `DELETE /events[/:id]` | Event list, creation, details, editing, or deletion according to method and ID |
| `GET`, `POST`, `PATCH`, `DELETE /entities/:kind[/:id]` | Same for character, account, server, and channel records. The character list is paged in name order with each picture on a given day. Other kinds, and characters with a typed name, return the first matches for pickers. Details include dated history and, where a Discord ID is known, its creation time |
| `GET /places` | Servers and group chats for the left column, with the name and icon in effect on a given day, main server first |
| `GET /search` | The top bar's search: the first few matching characters, accounts, places, artifacts, and events |
| `POST /entities/:kind/:id/history`, `DELETE /entities/:kind/:id/history/:entryId` | Add or remove a dated history entry with the parent's expected version. Removal names the history kind |
| `POST /entities/character/merge/preview`, `POST /entities/character/merge` | Conflicts and links a merge would change, then the reviewed same-archive merge with both expected versions and a choice for each conflict |
| `GET /date-preview` | How a typed date will be read with the contributor's timezone and date order, and whether a zone was assumed, so a form can show it before saving |
| `GET`, `POST`, `PATCH /requests[/:id]` | Missing-media request list, creation, details, and editing |
| `POST /requests/:id/status` | Needed, Resolved with found artifacts, or Unrecoverable with reason, and expected version |
| `GET /backlog`, `POST /backlog/flags`, `PATCH /backlog/:id` | Derived and manual gap review with permitted state changes |
| `GET /timeline`, `/calendar`, `/graph`, `/heatmap` | Bounded view data using shared filters and date rules |
| `GET /media/:mediaId`, `GET /media/:mediaId/preview` | Authorized original or preview streaming, including retained media. Never a direct filesystem path |
| `GET /edit-log` | Authorized log download |
| `PUT /artifact-logs-channel`, `DELETE /artifact-logs-channel` | Equivalent contributor configuration after Discord channel access and bot-permission checks |

The bracket notation in the table abbreviates separate collection and item routes, not a literal route string. Historical record and archive-setting mutations return the current record and version. Requests take `expectedVersion` on their changes and deletion. Operational membership, preference, and announcement-setting commands apply atomically without historical record versions. Source-specific fields and ordinary editable columns come from the schema and date contract. Relationship updates explicitly list additions and removals. A duplicate-review operation accepts additions only.

Lists accept `limit` from 1 to 100, default 50, and an opaque cursor with stable ordering. Shared filters use repeated IDs by category, optional text query, media types, date bases, the unidentified-characters flag, and inclusive `fromDay` and `toDay`. Board lists default to priority then creation time and stable ID. Relative request constraints filter as open-ended intervals, not artificial occurrence days. A timeline request requires a viewport and zoom. Return clusters and counts rather than every offscreen record.

Errors use `{code, message, details}`. Use `400` for invalid input, `401` for no session, `404` for missing or inaccessible archives, `403` for denied operations within a visible archive, `409` for stale versions or reference blockers, `413` for oversized media, `415` for unsupported formats, `429` for retryable upstream rate limits, and `503` for an unavailable dependency. Include current version and field differences on version conflicts. Do not expose credentials or internal paths in errors.

Stage downloads before acquiring the archive mutation lock. Limit each source request to 30 seconds without progress and five minutes overall. Retry transient network and upstream availability errors at most twice, after one and three seconds, respecting a longer upstream retry instruction within the overall limit. Do not retry permanent access, format, or size errors. Recheck access and duplicates before final commit.

## Configuration Contract

These settings are planned. Add new variables to `.env.example`, `compose.yaml`, and relevant guides only when implemented. Read them through `config.ts`.

| Setting | Default And Purpose |
| --- | --- |
| `DATA_DIR` | Existing repository setting. Contains bot state and managed archive roots |
| `ARCHIVIST_GUILD_IDS`, `OWNER_GUILD_ID` | Existing command availability boundaries |
| `ARCHIVIST_HOST` | `127.0.0.1` for local testing. Container deployments explicitly use `0.0.0.0` behind the chosen host exposure |
| `ARCHIVIST_PORT` | `3000` |
| `ARCHIVIST_BASE_URL` | `http://localhost:3000` for local testing. The address browsers use, which may include a path such as `https://guhbot.gavintranquilino.com/archivist`. Every page, route, and cookie lives under that path. Plain `http` is allowed only for localhost. Must match the registered Discord callback |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord sign-in application credentials, distinct from bot-token use. Required when starting the web listener |
| `ARCHIVIST_SESSION_SECRET` | Deployment-provided signing secret of at least 32 random bytes, outside archive folders |
| `GOOGLE_DRIVE_API_KEY` | Optional server-side API project key. When set, public Drive links use the Drive API. When empty, they use Google's public download address |

Use `/auth/discord/callback` under the configured base address, including its path, as the registered callback. Initial local setup tests this address; remote deployment registers its actual HTTPS callback. Do not silently use the execution host's timezone, guessed public hostname, or editor port-forward address.

Archive timezone, main server, lane gap, and display colors live in its database. Whitelists, self-service timezone preferences, remembered archive selections, announcement destinations, sessions, and job state live in `guhbot.db`. No setting stores a common Drive folder or requests a Google account connection.

## Dependency And Design Selections

The following exact direct versions were checked against public npm package metadata during planning. They have not been installed or integration-tested in this repository. The implementation must generate a lockfile with these direct pins, verify the selected runtime, and report a concrete incompatibility rather than silently changing the contract.

| Addition | Exact Version | Reason |
| --- | --- | --- |
| `react`, `react-dom` | `19.3.1` each | Shared interactive view and dialog state |
| `vite` | `8.3.8` | Frontend development and production asset build |
| `@vitejs/plugin-react` | `6.3.0` | React development integration |
| `tailwindcss`, `@tailwindcss/vite` | `4.3.5` each | Accepted styling and build integration |
| `fastify` | `5.12.8` | Optional typed web server and route validation |
| `@fastify/cookie` | `11.1.5` | Session cookie handling |
| `@fastify/static` | `10.1.12` | Built frontend asset serving |
| `@fastify/multipart` | `10.1.9` | Streaming bounded uploads |
| `archiver` | `8.0.0` | Streaming complete-folder zip exports |
| `exiftool-vendored` | `39.4.0` | Broad raw image and video metadata support |
| `@playwright/test` | `1.65.1` | Browser contribution-flow verification |
| `@types/react`, `@types/react-dom` | `19.3.0` each | Frontend type checking |
| `@types/archiver` | `8.0.0` | Export writer type checking |

Retain the repository's existing TypeScript, discordx, Discord.js, SQLite, and Sharp dependencies. Do not update them incidentally. Use built-in Node tests for backend and adapter coverage. Fastify plugins declare support for Fastify `5.x`; Vite and React peer requirements were checked from package metadata. Resolve optional compiler extras only if actually used, not to add an unrequested React compiler configuration.

Direct additions use the `MIT` license except Playwright's `Apache-2.0`. Review and preserve upstream notices for bundled tools and fonts. Package metadata was read only, and no package scripts were run. Relevant primary references are [Vite](https://vite.dev/guide/), [Tailwind integration](https://tailwindcss.com/docs/installation/using-vite), [Fastify](https://fastify.dev/docs/latest/), [Node tests](https://nodejs.org/api/test.html), and [the npm registry](https://registry.npmjs.org/). Keep runtime metadata tools and their prerequisites in the built image. No request-time tool download or install.

Use JetBrainsMono Nerd Font Regular from [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1), bundled as its original font file with notices and a monospace fallback. Use accessible text labels alongside glyph-only controls.

| Color Role | Value |
| --- | --- |
| Outer background | `#1e1f22` |
| Sidebars and secondary surfaces | `#2b2d31` |
| Main content | `#313338` |
| Primary text | `#f2f3f5` |
| Muted text | `#b5bac1` |
| Accent and selected controls | `#5865f2` |

These are selected project tokens, not a claim to mirror Discord's current theme exactly. Use flat borders, no gradients or shadows, visible focus, non-color state indicators, reduced motion, and accessible dialogs. The owner changes archive display colors; this is not a general theme editor. No light theme in this release.

Use an 8-pixel spacing scale, 16-pixel base text, 14-pixel secondary labels, and controls at least 40 pixels high. At 1280 by 800, show server navigation, channel navigation where relevant, main research content, and a character sidebar. At 390 by 844, collapse sidebars into labeled drawers and keep viewing, search, artifact submission, and record editing usable. Test at both sizes and keyboard-only. Detail views use historical account avatars where known, then a labeled character fallback picture, then initials. Do not fabricate a historical profile when only a current image exists.

## Delivery And Acceptance

Complete the entire hosted-app scope through these internal milestones.

| Milestone | Deliverable | Acceptance Evidence |
| --- | --- | --- |
| `M0` Contract And Tooling | Final reviewed contract, exact migrations, validation and interface definitions, dependency lock, and fixture harness | Schema and operational migration checks pass. Runtime and package compatibility are verified. No unresolved product placeholders |
| `M1` Storage And Operations | Independent archive folders, bot registry and whitelist, date values, metadata preservation, editable logs, version conflicts, and recoverable mutations | Restart persistence, reference blockers, source uniqueness, date precedence, and interrupted-deletion/log-rewrite checks pass without changing AFK data |
| `M2` Discord Contribution | Complete contributor and owner commands, public Drive intake, attachments, duplicate review, channel announcements, and exports | Test-server rehearsal verifies accepted inputs, different public folders, original bytes and metadata, failed sources, stale reviews, and unchanged announcement history |
| `M3` Historical Research | Full identities, observations, memberships, character merge, events, missing-media requests, and board transitions | Explicit fixtures cover nullable identities, history lookup, both event range meanings, all request constraints, anchor corrections and deletion blocking, and no assignees |
| `M4` Hosted App | Owner-controlled lifecycle, Discord login, every contributor operation, all six views, and responsive design | Browser flows prove parity, next-request revocation, keyboard access, mobile forms, historical date labels, and usable stopped-app outcomes |
| `M5` Release Validation | Complete export and clean restore, migration compatibility, performance, CI, and operating documentation | Zip opens without bot state or source access, required checks run in CI, performance results name the host, and configured live-source and local-hosting rehearsals pass |
| `M6` Future Viewer | Excluded from this build | A separate future project may use the published archive contract |

Before building the `M2` Discord intake flow, show the owner the exact command, character selection, reply, and duplicate-review steps. Before building the `M4` views, publish a clickable prototype with fake data for the owner's review. The owner asked on 2026-11-23 to see it during `M3`. Record the agreed layout, tray, and view decisions in this plan. The prototype is not reused as application code.

### Required Automated Scenarios

* Preserve original image and video bytes, metadata, one-original cardinality, derived previews, and explicit unknown dates. Preview failure does not discard a good original.
* Reject invalid dates, missing descriptions, links to records that do not exist in the selected archive, oversized or unsupported files, private sources, and partial original downloads without creating completed artifacts.
* Verify remembered archive selection. An omitted archive uses the contributor's last explicit selection, missing or revoked access requires a selection, unregistration clears it, and every reply names the archive.
* Verify that the unidentified-characters flag creates a missing-characters card and an artifact without the flag does not.
* Verify source identity rather than content matching, reuse on duplicate links, chosen metadata changes only, cancellation, expiry, concurrency, and reintake after deletion.
* Verify exact, estimated, file-date, and undated precedence, preservation of lower-priority assertions, unknown source timezones, personal defaults, explicit offsets, date-only stability, daylight-saving ambiguity, and fixed shared day buckets.
* Verify both event range meanings and evidence-free creation, gap creation and clearing, disputed reasons, and one artifact supporting multiple events.
* Verify all missing-media temporal forms, required characters and description, open bounds, dynamic before-start and after-end event anchors, correction propagation, deletion blockers, and accepted board transitions.
* Verify linked-identity deletion blockers, surviving evidence, media retention, log-entry removal for deleted records, unchanged other logs, and unchanged upload-history messages.
* Verify temporary-file and journal recovery after failures at each database, media, log, and operational-state boundary. No half-applied mutation may be exported.
* Verify owner versus member privileges, archive isolation, denied direct API and media access, invalid sessions, same-origin mutation checks, and revocation during an open session.
* Verify listener start, repeated start and stop, port conflict, bot shutdown, restart-stopped state, and continuing Discord contribution while the listener is stopped.
* Verify announcement settings for every contributor in the selected archive, web-originated uploads, notification failure after saved evidence, and no blind resend after an indeterminate external delivery result.
* Verify one complete zip with log, originals, previews, and retained media; absence of credentials and operational state; clean-location restore; and unsupported schema refusal.
* Verify lane assignment for servers, group chats, threads, and unassigned records, parallel event-band rows for overlapping ranges, day-bucket artifact counts, automatic server name and icon markers, and historical character pictures from main accounts.
* Verify empty archives, crowded days, long gaps, reappearing server lanes, multi-server events counted once, search and filter semantics, unknown memberships, and accessible visual states.

Add planned commands `test:archivist:core`, `test:archivist:discord`, `test:archivist:web`, and `test:archivist:e2e`. CI jobs `archivist/core`, `archivist/discord`, and `archivist/web` run the relevant suites, with route and browser coverage in the web job. Mock Discord and Google in CI. A real test server and representative public Drive files supplement those tests. Do not require production credentials in pull-request checks.

Retain and run `npm run check`, `npm run build`, and `python3 tools/scripts/run_checks.py`. Extend the build to compile backend and frontend and package the frontend, fonts, metadata tools, and migrations in the container image. Update only actual commands and tooling in repository guides when implemented. Run project checks in the dev container when available and report environment limitations.

### Capacity Fixture

Support 10 registered archives, each with 50,000 artifacts, 10,000 events, 2,000 characters, and 100 gigabytes of media, with 10 concurrent contributors. Do not eagerly load every media file or graph edge into a page. Use indexed windows, pagination, clustering, and bounded queries. Target one second at the 95th percentile for indexed lists and viewport requests, excluding media transfer and export compression.

Record the actual localhost benchmark host, runtime, dataset seed, request mix, warm-up, and measured durations. A planning document cannot claim a performance target passed. Use synthetic metadata at target record counts without putting 100 gigabytes into ordinary CI. A separate deployment rehearsal validates large-file and export behavior on representative storage.

## Decision Record And Handoff Status

The owner's accepted batches A through F are reconciled here. Later clarifications supersede earlier suggestions.

| Topic | Final Decision |
| --- | --- |
| Portable storage | One folder per archive with SQLite, media, and edit log; complete zip exports |
| Source evolution | Google Photos and a common shared folder were considered, then replaced by contributors' public Drive file links. No Google user login or source registration |
| Contribution | Discord primary, equivalent web operations, owner-only infrastructure administration, and contributor announcement settings |
| Research backlog | No assignees; missing-media requests require temporal information, a character, and description; Needed, Resolved, and Unrecoverable buckets |
| Relative requests | Before event start, after event end, follow corrected dates, and block anchored-event deletion |
| Deletion | Permanent archive record deletion, retained media, removed own edit entries, no deletion log, and unchanged external upload-history messages |
| Scope | Full hosted app and all six views (the album was added in the prototype review), with separate standalone viewer later |
| Archive selection | Discord commands may omit the archive and reuse the contributor's last explicit selection, stored in `guhbot.db`. Replies always name the archive |
| Intake links | Intake links only existing records. Contributors create a missing character before linking it |
| Identification cards | A yes/no unidentified-characters flag, set from a button on the artifact reply rather than an intake field. Missing-characters cards come only from the flag |
| Intake volume | One artifact per submission, with thousands expected over time. Keep each Discord intake to as few steps as possible |
| Confirmed as specified | Any archive member may permanently delete permitted records. Artifact estimates remain single calendar days |
| Web layout | Three columns from the owner's sketch, with servers and group chats on the left, the current view in the center, all characters on the right, and a per-view tray of actions |
| Timeline lanes | Servers and group chats get solid, editable lane colors. Dashes mean uncertainty. Events do not recolor lanes |
| Timeline marks | One green dot per day, shaded by count, opening a gallery. Ranged events form labeled parallel strips in a band. Red arrows mark single-day events. Server name and icon changes get their own arrow color |
| Main accounts | Characters have a dated main-account history, and their pictures follow it along the timeline |
| Discord intake | Comma-separated characters with autocomplete, separate exact and estimate date fields, a private reply with Edit, Add characters/events, Someone unidentified, and Delete, short IDs, and tick-to-apply duplicate review |
| Typed dates | Common written forms are accepted. Each contributor chooses year-month-day, month-day-year, or day-month-year for all-number dates, defaulting to year-month-day. Dates display with month names for everyone |
| Exports | Owner-only, from `/archivist-admin export`. The zip is written on the host and kept until the owner deletes it. No Discord or web download |
| Editing split | Discord is for uploads and quick edits. Dated history editing and character merge are website-only, because editing is easier with the whole record in view |
| Terminology | Say "character" for the archive's records of real people, never "person" or "people", in the interface, the code, and the schema. Archive schema version 3 renames the stored names. Discord users are contributors |
| Service boundary | The archive rules and website stay independent of the Discord bot, enforced by a test, so the website can later become the source of truth as its own service with the bot as an API client. The move itself is deferred (owner, 2026-11-23). See [Service Boundary](#service-boundary) |
| Hosting path | The website may live under a path, such as `guhbot.gavintranquilino.com/archivist`. Plain HTTP only on localhost |
| Prototype review | Approved on 2026-11-23 after three rounds. The decisions are under [Prototype Review Decisions](#prototype-review-decisions), including the new album view, viewer-local lane order and hiding, the deterministic graph layout, the picture album with GIF avatars, account-menu preferences, and creation dates derived from Discord IDs |
| Research on the website | The research board, manual research flags, and moving missing-media requests between buckets are website-only. Derived gap cards clear themselves when the data is added. A request resolves when someone links the artifact that has the media, since the archive cannot tell by itself that an upload is the missing media. Deletes that would be refused are refused before the confirmation button appears |
| Prototype timing | The clickable prototype is built during `M3`, so layout feedback arrives before the `M4` views are built |
| Command shape | `/a` is a short alias of `/archivist` with the same commands. The archive option comes last in every command, because contributors change it least |
| Drive without a key | Public Drive links download from Google's public download address without setup. An optional `GOOGLE_DRIVE_API_KEY` switches to the official Drive API |
| Formats | Images, videos, and audio are accepted: JPEG, PNG, WebP, GIF, MP4, MOV, WebM, MKV, AVI, MP3, M4A, WAV, Ogg, and FLAC |
| Exact-date basis | Exact dates need no written basis, for artifacts and events. Only estimates need a reason. Archive schema version 2 removes the basis requirement and keeps earlier values |

The earlier `Q01` through `Q19` topic discussion is resolved into the contract sections rather than retained as a competing open-question table. Accepted request and announcement clarifications are incorporated. The rows from archive selection through the end of the table record owner clarifications from 2026-11-23, including the test-server rehearsal feedback. If a final review changes a rule, update its contract, schema, interfaces, and acceptance fixture together.

### Outstanding Verification Prerequisites

* Provide representative publicly readable image, video, and audio files for the Drive rehearsal, and optionally a Drive API key. Do not read or commit private `.env` values during planning.
* Configure the actual Discord sign-in application and exact localhost callback before the local integration rehearsal. Provide public HTTPS hosting only for a later remote deployment.
* Generate and validate the actual lockfile, container packaging, migration files, and runnable test commands during implementation. Registry metadata and a schema smoke check do not replace an application build.
* Review and accept the newly explicit technical contract and schema draft before authorizing the agent to implement it.

**Current state:** Product decisions are recorded. This consolidated technical contract is ready for final review. No application code, migrations, deployment configuration, packages, or credentials have been changed as part of planning.
