# Development

Notes for anyone developing the connector further, whether by hand or with a coding agent. Measured iCloud quirks and the reasoning behind individual decisions are in [`ICLOUD-NOTES.md`](ICLOUD-NOTES.md).

## Commands

```bash
npm install
cp .env.example .env        # enter your credentials yourself, never paste them into a chat
npm run typecheck
npm test                    # no network needed (simulated calendar and IMAP server)
npm run build:mcpb          # builds dist/icloud-mcp-<version>.mcpb (checks manifest and package contents)
scripts/call.sh <tool> key=value ...   # calls a tool through the MCP Inspector (server from src, values from .env)
scripts/dev-bundle.sh       # starts the bundled package
npm run feasibility         # small sign-in test (lists calendars, address books, folders)
npm run imap-capabilities   # iCloud Mail capabilities after sign-in and folder flags (read-only)
```

## Structure

```
manifest.json            Desktop Extension manifest (0.3), user_config, tool list
src/core/                domain logic, knows nothing about MCP (reusable for a later hosted connector)
  calendar/ contacts/ mail/   access (tsdav / imapflow), processing and service for each
  automation/            osascript runner and the fixed JXA scripts (scripts/*.ts) for Reminders and Notes
  reminders/ notes/      services on top of the runner (backend interface + grants), Markdown to Notes HTML
  permissions.ts         central permission checks (WriteGrant for create/update/delete, DraftGrant, TrashGrant, MoveGrant, FlagGrant, ContactWriteGrant)
  contacts/vcardEdit.ts  line-level vCard editing (create and change contact cards without re-serializing)
  calendar/backup.ts     .ics / .vcf backup before deleting, moving or changing, cleanup (90 days / 200 files)
  calendar/invitation*.ts  reading invitations (.ics) and import_invitation
  mail/trash.ts          trash_message: checks subject and sender, then moves
  mail/move.ts flags.ts  move_message and set_message_flags (shared check of id, subject and sender in mail/verify.ts)
  mail/attachment.ts     read_attachment: text, PDF (unpdf, bundled), calendar invitations (calendar/invitation.ts)
  untrusted.ts           delimiting untrusted content, structuredContent
src/mcp/                 thin MCP layer: tools, Zod schemas, annotations
src/stdio.ts             entry point (stdio)
test/                    tests; test/miniImap.ts is a simulated IMAP server that mimics iCloud quirks and logs every command
docs/ICLOUD-NOTES.md     measured iCloud quirks and decisions
```

## Safety rules

These rules are the core of the project. They are enforced in code, not just in tool descriptions, and tests guard them. Changing them changes the promise made to users.

- **Permissions in code:** write methods require a grant from `src/core/permissions.ts`. Tool annotations (`readOnlyHint`, `destructiveHint`) must be accurate.
- **Moving mail:** `move_message` moves with the same direct `UID MOVE` as `trash_message`; the single `exec('UID MOVE')` sits in the private `uidMove`, reached only from `moveToTrash` and `moveMessages` after their grant checks (`TrashGrant`, `MoveGrant`). `authorizeMove` refuses the Trash, Drafts, Sent and Junk (by attribute, role and name) and the source folder as targets. Folders are opened read-write (`SELECT`) only for `UID MOVE` and `STORE`.
- **Only three ways to delete:** `delete_event` (own event, `.ics` backup first; never with attendees, another organizer, in shared calendars or as a single occurrence), the **source of a move** (`update_event` with `move_to_calendar`; `authorizeEventMove` issues one create grant for the target and one delete grant for the source; order enforced in `moveEvent`: grant, `.ics` backup, create in the target, read back and compare, only then `DELETE` with `If-Match`; never out of shared calendars, never with attendees or another organizer, never single occurrences; if the delete fails both places are reported and nothing more happens) and `trash_message` (IMAP `UID MOVE` into the folder with the `\Trash` flag, at most 20, subject and sender are checked; never `\Deleted`, never `EXPUNGE`). Guard tests in `test/permissions.test.ts` enforce this in the source code (the allowed `deleteObject` calls, the two places that issue a delete grant, and their order).
- **No sending:** no SMTP in the code. Mail can be marked only with `set_message_flags`: IMAP `STORE` of exactly `\Seen` and `\Flagged` (`ALLOWED_STORE_FLAGS`, enforced by the `FlagGrant`; `\Deleted`, `\Draft`, `\Answered` and keywords are never set). A guard test checks that `STORE` exists only in `setFlags`.
- **Contacts:** only single cards are created (`PUT` with `If-None-Match: *`) or changed (`PUT` with `If-Match`), always with a `ContactWriteGrant`. `update_contact` saves a `.vcf` backup first (`contacts-backup/`, same rules as the `.ics` backup). No `DELETE` on CardDAV, no tool to delete contacts or groups, group cards are never written (the grant refuses them). `ical.js` must not re-serialize a vCard (see ICLOUD-NOTES.md): edit on the line level.
- **No invitations:** `create_event` and `update_event` set no attendees. Events with attendees or another organizer are not changed or moved. A single occurrence of a series is changed by an override VEVENT with `RECURRENCE-ID` in the same resource (`locateOccurrence`, `applyOccurrencePatch`); master and other overrides stay byte-for-byte equal as jCal (checked inside the function); deleting single occurrences is still refused. `import_invitation` builds the new event from a whitelist of properties (no ATTENDEE, ORGANIZER, METHOD, X- properties), under a new UID, and never sends anything (no iTIP, no REPLY).
- **Automation (Reminders, Notes):** see "Automation pattern" below. Rights: `ReminderGrant` (create in a named list or the default list, update, complete up to 20; no grant exists for deleting), `NoteGrant` (creating ONE new note, in the default folder, a named folder, or a shared folder only with `shared_folder`; no grant exists for changing, moving or deleting notes). Apple's scripting interface does not say whether a reminder list is shared, so there is no `shared_list`; Notes does (`folder.shared`).
- **Shared calendars** (marked `shared: true` in `list_calendars`) only with an explicit `shared_calendar="<name>"`. Never run live tests in shared calendars.
- **Reading mail without side effects:** open folders read-only (`EXAMINE`) and use `BODY.PEEK` (also for `read_attachment`, which fetches just one part). Drafts only via `APPEND` with `\Draft` into the Drafts folder; a forward draft carries only the original's attachments (at most 20 MB), re-encoded as Base64.
- **Untrusted content:** output mail and event content delimited as untrusted content. No content and no credentials in logs; sanitize error messages.
- **Credentials** only as `user_config` with `sensitive: true` (macOS Keychain) or locally in `.env`, which is never committed. Separate logins for CalDAV/CardDAV (Apple ID) and IMAP (`@icloud.com`).
- Do not change the extension's internal identifier (`name: icloud-connector` in the manifest). Otherwise an update creates a second, empty extension. `test/manifest.test.ts` guards this.

## Automation pattern (Reminders and Notes)

iCloud has no open interface for Reminders and Notes, so iClaude controls the apps on the Mac with `/usr/bin/osascript -l JavaScript` (`src/core/automation/runner.ts`). The rules, enforced by `test/automation.test.ts`:

- **Fixed scripts.** Every script is a constant string in its own file under `src/core/automation/scripts/` (`String.raw` without placeholders) and is registered in `scripts/index.ts`. Nothing is assembled at run time: no template placeholders, no string building, no `eval`/`Function`, no `doShellScript`, no `ObjC`, no `System Events`, no delete/remove/move verbs. Each script controls exactly the one app it declares.
- **Input as one JSON argument.** The runner starts `osascript -l JavaScript -e <script text> <json>` with `execFile` (no shell). The script reads `argv[0]` with `JSON.parse` and nothing else. A test proves with hostile input (quotes, line breaks, `do shell script`, backticks) that the script text never changes and that nothing is executed (against the real osascript on a Mac).
- **Output as one JSON text** `{ok: true, data}` or `{ok: false, code, message}`, validated with Zod. Scripts report problems with fixed texts only; error messages never repeat app output.
- **Dates** go in as ISO 8601 (or `YYYY-MM-DD` parts for all-day) and are turned into `Date` objects inside the script. Never use localized AppleScript date text.
- **Timeouts:** 120 s for the first call per app (the macOS permission question), 30 s afterwards, some scripts longer; then the process is killed (`SIGKILL`). Error `-1743` becomes the way to System Settings > Privacy & Security > Automation. One script at a time.
- **Only on macOS.** On other systems the runner throws "only available on macOS"; unit tests replace the runner with a fake, CI (Linux) never starts osascript.
- **Speed:** every Apple event to Reminders can take 0.5 s on a cold app. Read properties as bulk arrays over a whole collection (`app.reminders.name()`), filter with `whose`, never loop over items asking for properties one by one. See ICLOUD-NOTES.md for measurements.
- **Adding a script:** new file in `scripts/`, export it from `index.ts`, call it only from a service whose writing methods require a grant from `permissions.ts`. The guard tests pick it up automatically.

## Known pitfalls

- **Never run the Claude app in Node mode** (`ELECTRON_RUN_AS_NODE`). The mode is disabled and a second app instance starts instead. Plain Node is enough for testing (`scripts/dev-bundle.sh`).
- **iCloud:** `allprop` returns no calendar data. Header search needs `<id>` with angle brackets. TEXT search doesn't find MIME-encoded subjects. ETags come in quotes, and clients occasionally drop them (normalized).
- **Without an advertised `MOVE` capability, imapflow silently falls back to `COPY` + `\Deleted` + `EXPUNGE`** (`messageMove`), and iCloud doesn't advertise `MOVE` but understands it. That's why `moveToTrash` sends `UID MOVE` directly via `exec`. `messageMove` must not appear anywhere in the code (guard test).
- imapflow guesses special-use folders by **name** when the server doesn't offer `SPECIAL-USE` (the case with iCloud). The `trash` role therefore only counts if the `\Trash` flag is in the LIST response (`roleBy: 'flag'`).
- The MCP Inspector reads `--tool-arg` values as JSON. In the shell, `echo` can break a `\n` in JSON; use `printf '%s'` instead.
- `timeout` doesn't exist on macOS. For smoke tests of the package, use a small Node script (unpack the package, start `server/index.mjs` with dummy credentials, query `tools/list`).
- Unsigned extensions show a notice during installation. That is normal for a self-built extension.

## Releases

Releases are made by the workflow `.github/workflows/release.yml` (tests, build, publish). Do not run `gh release create` by hand.

1. Raise the version in `package.json` (`npm version <version> --no-git-tag-version`; the build script copies it into the manifest, and `manifest.json` has to carry the same number) and in `src/mcp/server.ts`.
2. Write the release text in English as `docs/releases/v<version>.md`.
3. Run `npm run typecheck`, `npm test` and `npm run build:mcpb`; commit and push to `main`.
4. `git tag v<version> && git push origin v<version>`. The workflow checks that the tag matches `package.json`, runs the tests, builds the `.mcpb` and creates the GitHub release with the release text. Follow it with `gh run watch`.
5. Check that the `.mcpb` hangs on the release (`gh release view v<version>`), download it (`gh release download v<version>`) and open it to install the update.

The `.mcpb` does not belong in the repository. Make sure the tag points at the commit that carries the new version, and that a push to `main` really succeeded before the tag is pushed.
