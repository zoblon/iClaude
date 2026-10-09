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
- **Shared calendars** (marked `shared: true` in `list_calendars`) only with an explicit `shared_calendar="<name>"`. Never run live tests in shared calendars.
- **Reading mail without side effects:** open folders read-only (`EXAMINE`) and use `BODY.PEEK` (also for `read_attachment`, which fetches just one part). Drafts only via `APPEND` with `\Draft` into the Drafts folder; a forward draft carries only the original's attachments (at most 20 MB), re-encoded as Base64.
- **Untrusted content:** output mail and event content delimited as untrusted content. No content and no credentials in logs; sanitize error messages.
- **Credentials** only as `user_config` with `sensitive: true` (macOS Keychain) or locally in `.env`, which is never committed. Separate logins for CalDAV/CardDAV (Apple ID) and IMAP (`@icloud.com`).
- Do not change the extension's internal identifier (`name: icloud-connector` in the manifest). Otherwise an update creates a second, empty extension. `test/manifest.test.ts` guards this.

## Known pitfalls

- **Never run the Claude app in Node mode** (`ELECTRON_RUN_AS_NODE`). The mode is disabled and a second app instance starts instead. Plain Node is enough for testing (`scripts/dev-bundle.sh`).
- **iCloud:** `allprop` returns no calendar data. Header search needs `<id>` with angle brackets. TEXT search doesn't find MIME-encoded subjects. ETags come in quotes, and clients occasionally drop them (normalized).
- **Without an advertised `MOVE` capability, imapflow silently falls back to `COPY` + `\Deleted` + `EXPUNGE`** (`messageMove`), and iCloud doesn't advertise `MOVE` but understands it. That's why `moveToTrash` sends `UID MOVE` directly via `exec`. `messageMove` must not appear anywhere in the code (guard test).
- imapflow guesses special-use folders by **name** when the server doesn't offer `SPECIAL-USE` (the case with iCloud). The `trash` role therefore only counts if the `\Trash` flag is in the LIST response (`roleBy: 'flag'`).
- The MCP Inspector reads `--tool-arg` values as JSON. In the shell, `echo` can break a `\n` in JSON; use `printf '%s'` instead.
- `timeout` doesn't exist on macOS. For smoke tests of the package, use a small Node script (unpack the package, start `server/index.mjs` with dummy credentials, query `tools/list`).
- Unsigned extensions show a notice during installation. That is normal for a self-built extension.

## Releases

Bump the version in `package.json` (the build script copies it into the manifest), run `npm test` and `npm run build:mcpb`, then attach the file from `dist/` to a GitHub release tagged `v<version>`. The `.mcpb` does not belong in the repository.
