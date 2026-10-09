# iCloud notes

Results of our own measurements against iCloud (as of 2026-10-08) and the decisions that follow from them.
All measurements were read-only, except where "test calendar" is stated explicitly (for 0.2.0 see the sections "Deleting events" and "Moving to the Trash"; they note what was only verified against test servers). No content from events or mails is recorded here.

## Calendar (CalDAV)

### Queries: request properties individually

Measured on a private calendar with 32 events (`calendar-query`, time range 2026–2027):

| Request | Result |
|---|---|
| `calendar-data` without restriction | 32 of 32 with data, 136 KB, approx. 470 ms |
| `allprop` (instead of `prop`) | **0 of 32 with calendar data** (metadata only, 23 KB) |
| `allprop` + `allcomp` inside `calendar-data` | practically empty (approx. 1 KB for 32 events) |
| VEVENT properties individually (`comp`/`prop`) | 32 of 32 with data, **37 KB (−73 %)**, approx. 370 ms |

Decision: read queries (`list_events`, `search_events`, `find_free_slots`) request exactly the properties they
need (`UID, SUMMARY, DTSTART, DTEND, DURATION, RRULE, RDATE, EXDATE, RECURRENCE-ID, LOCATION, DESCRIPTION, STATUS, TRANSP,
ORGANIZER, ATTENDEE, SEQUENCE`, plus `ACTION`/`TRIGGER` of the alarms). This lives in `src/core/calendar/caldav.ts` (`EVENT_PROPS`).

**Consequence:** a copy fetched this way is incomplete. It is **never used for writing**. `update_event` always loads the event
in full via GET (`getObject`), checks permissions and ETag on it and changes exactly that file.

### Time zone definitions are missing in restricted responses

For restricted queries, iCloud doesn't include the `VTIMEZONE` component (three variants tried: `comp` with `prop TZID`,
empty `comp`, `allprop`/`allcomp`). For common names (IANA, e.g. `Europe/Berlin`) this doesn't matter, because times are resolved
via the name. If an unknown time zone name appears (e.g. Windows names like "W. Europe Standard Time" from
Outlook invitations), exactly that event is reloaded in full via GET (`hasUnknownTzid`).

### Single event via GET

`GET <calendar>/<file>.ics` works and returns the full event (`text/calendar`) and the ETag in the `ETag` header.
The ETag is identical to the one from the query and comes in quotes (`"muznm0s0"`).
Some clients drop the quotes, so ETags are compared without `W/` and without quotes.
When writing, the server still checks the real ETag (`If-Match`).

### Writing

- When a write is refused, `tsdav` does **not** throw an error but returns the `Response`. The status is checked by our code
  (412 = event changed in the meantime, 403 = no permission, 404 = not found).
- Creating sends `If-None-Match: *` (never overwrite), updating sends `If-Match: <ETag>`.
- On save, iCloud replaces the `VTIMEZONE` sent along with its own complete definition. This doesn't matter.
- After our write tests, the stored files contained neither `ATTENDEE`, `ORGANIZER` nor `METHOD`; alarms were preserved.
- Updates increment `SEQUENCE` by one and reset `LAST-MODIFIED`, so that Apple devices pick up the change.

### Detecting shared calendars

Properties per calendar (PROPFIND on the calendar collection):

- Calendars **I share myself**: `resourcetype` contains `sharedOwner`, and `cs:invite` is present. The owner is the own account.
- Private: only `calendar`, no `invite`, the owner is the own account.
- Calendars of other people shared with me (`shared` in `resourcetype` or a different owner) did not occur in the test account.
  The code treats them as shared, but this has not been verified live.

Rule in the code (`classifyCalendar`): **when in doubt, a calendar counts as shared.** Only a calendar that clearly belongs to the own account
and carries no sharing markers counts as private.

### Other

- Reminders lists appear as calendars with `VTODO`; they are not supported.
- The Inspector CLI reads `--tool-arg` values as JSON. A value like `"abc"` (with quotes) arrives without the quotes.

## Contacts (CardDAV)

- One address book, empty display name; a contact's ID is the path of its file (`…/carddavhome/card/<UUID>.vcf`).
- Apple links labels via group prefixes (`item1.EMAIL` + `item1.X-ABLabel:_$!<Work>!$_`); this is resolved to "Work".
- Birthdays without a year are stored with the year 1604 or 1900; they are output as `--MM-DD`. Photos are never included.
- Birthdays and further dates: `BDAY;VALUE=date:1604-03-15` (placeholder year 1604, sometimes 1900; `X-APPLE-OMIT-YEAR` is also honoured). Further dates are `itemN.X-ABDATE` with an `itemN.X-ABLabel` (`_$!<Anniversary>!$_`); relationships are `itemN.X-ABRELATEDNAMES` (label e.g. `_$!<Spouse>!$_`); social profiles are `X-SOCIALPROFILE;type=twitter;x-user=name:url`; messengers are `IMPP;X-SERVICE-TYPE=Skype:skype:name` or `X-JABBER`, `X-AIM`, … ORG is `Company;Department;`.
- Groups are vCards with `X-ADDRESSBOOKSERVER-KIND:group` and one `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<UID>` per member. They are only read; the group cards are skipped when contacts are parsed.

### Changing contacts (0.3.0)

- **`ical.js` must not re-serialize a vCard.** A test with `ICAL.stringify` showed that Apple's peculiarities are altered: group prefixes are capitalised (`item1` becomes `ITEM1`), several `type` parameters are merged, and `BDAY;VALUE=date:1604-03-15` becomes `16040315`. `src/core/contacts/vcardEdit.ts` therefore works on the text: the card is split into logical lines (a folded line keeps its original folding), only the touched properties and their `itemN.X-ABLabel` lines are changed, added or removed, and every other line is written out byte for byte. New lines are escaped (comma, semicolon, backslash, line break) and folded at 75 octets. New `itemN` groups never collide with existing ones. `test/contactWrite.test.ts` checks with a realistic Apple card (itemN groups, PHOTO, BDAY 1604, X-ABDATE, X-ABRELATEDNAMES, X-SOCIALPROFILE, multi-line NOTE) that changing a phone number leaves all other lines byte-identical.
- `ical.js` also leaves `\;` in NOTE values escaped, so notes are decoded from the raw line.
- Labels are written the way Apple does: Home and Work as `type=` parameters, Other, Main, HomePage and custom labels as `itemN.X-ABLabel` (`_$!<Other>!$_` for the built-in ones). This is based on the format of existing cards and **has not been checked against freshly created cards on iCloud yet** (no sign-in was available while this was written).
- Creating: new UID, file name `<UID>.vcf`, `PUT` with `If-None-Match: *`. Updating: the card is loaded with GET (not from the cache), checked (name, optional ETag), backed up, then written with `If-Match`. The contact cache is emptied after every write.
- Duplicate check when creating: same email address (case-insensitive), same phone number (digits, last 8), same full name (accent- and case-insensitive).
- No writing of group cards and no `DELETE` on CardDAV; `test/permissions.test.ts` guards both.

## Mail (IMAP), results of the feasibility test

- `imap.mail.me.com:993`, login with the @icloud.com address.
- The capability list includes neither `SPECIAL-USE` nor `THREAD=…` nor `MOVE`, but does include `UIDPLUS` (measured after sign-in on 2026-10-08, see "Moving to the Trash").
  **Correction (2026-10-08, measured live):** only "Sent Messages" (`\Sent`) and "Deleted Messages" (`\Trash`) carry a special-use flag in the LIST response; "Drafts", "Archive" and "Junk" carry none, INBOX only `\Noinferiors`.
  `imapflow` therefore recognizes the roles of Drafts, Archive and Junk by **name** (English default names); only the Trash is recognized by its flag in 0.2.0.
- Folders: INBOX, Sent Messages, Drafts, Archive, Junk, Deleted Messages. The archive is large (around 6000 mails): full-text search there needs time limits and caps.
- Conversations (`get_thread`) have to be built by our code from the `Message-ID`, `In-Reply-To` and `References` headers, because `THREAD` is missing.

### Requirements for reading mail (implemented and tested)

1. Mailboxes are opened **read-only** for reading (`EXAMINE`), content is fetched only with `BODY.PEEK`. The IMAP interface in the code (`ImapLike`) has
   no method at all that sets flags, deletes, moves, copies or appends.
2. Test (`test/mailWire.test.ts`): the real `imapflow` talks to a test server that logs every command and behaves like a real server
   (opening read-write + fetching without PEEK would mark the message as read). After all read tools, the flags are identical, there was only `EXAMINE`
   and only `BODY.PEEK`, and `STORE`, `COPY`, `MOVE`, `APPEND`, `EXPUNGE`, `DELETE`, `CREATE` or similar were never sent. A counter-check shows that the test server detects violations.
3. `get_message` returns long texts in pages (8000 characters, counted in Unicode characters) with `page.offset`, `page.nextOffset`, `page.totalLength`.
   An offset past the end is clamped to the end.

Further decisions:

- HTML mails: hidden elements (`display:none`, `visibility:hidden`, `font-size:0`, `opacity:0`, height/width 0, `hidden`), scripts, styles and image URLs
  are not included. This is a known way to hide invisible instructions in mails.
- iCloud's server search doesn't find words in MIME-encoded headers (subjects with umlauts or special characters), not even with `TEXT`.
  Measured live: for a mail with a non-ASCII subject, `TEXT` failed to find 2 of 6 subject words. When searching by sender, recipient, subject **and full text**,
  the newest 300 messages in the folder are therefore additionally checked locally with decoded headers (only if the server search returned fewer hits than the limit).
  Only the server searches the message body itself.

### Conversations: header search needs angle brackets

Measured in the Drafts folder: `SEARCH HEADER Message-ID <value>` only finds a match if the value is searched **with** the angle brackets (`<abc@icloud.com>`).
Without brackets (or with only the UUID), iCloud **silently returns 0 hits**, while other servers compare as a substring. With brackets,
`Message-ID`, `In-Reply-To`, `References` and their combination with `OR` work. The case of the Message-ID must match.
`get_thread` therefore searches with `<id>`. The test server (`test/miniImap.ts`) reproduces this behaviour, and a test fails without brackets.
`SEARCH TEXT <uuid>` also finds the message, but would be too imprecise as a fallback.

### Drafts (IMAP APPEND)

- The draft is placed via `APPEND` into the folder with `\Drafts` (here "Drafts"), with the flags `\Seen` and `\Draft`, as Apple Mail does for its own drafts.
  Without `\Seen`, every draft would be counted as an unread mail.
- iCloud supports `UIDPLUS`: the response contains `APPENDUID`, from which the draft's ID is built (for `get_message`, `reply_to_id`).
- The message is a simple UTF-8 plain-text mail (Base64). Subject and names are encoded according to RFC 2047. There is no Bcc and there are no attachments.
- Measured live (test drafts to the own address): text, subject with umlauts and emoji, sender, recipient and the reply linkage
  (`In-Reply-To`, `References`) come back from iCloud unchanged. Drafts don't count as unread.
- A connection drop during `APPEND` is **not** retried, so that two drafts are never created.

## Deleting events (0.2.0)

Decisions (implemented and tested against test servers, `test/delete.test.ts`):

- `delete_event` loads the event via GET, checks permissions (`authorizeDelete`), compares title and start time with the given values and then creates the backup. Only then does it send
  `DELETE <event>.ics` with `If-Match: <ETag from the GET>`. If the backup fails, nothing is deleted; if the deletion fails, the backup just created is removed again.
- Refused: shared calendars (always, `shared_calendar` doesn't count), attendees, another organizer, single occurrences (`occurrence_start`), entries without a master event, read-only/subscribed calendars.
- The `DELETE` is sent with `fetch` (like the GET), not with `tsdav`: that way `If-Match` is visible and verified by an HTTP test; credentials only go to the calendar server and only for resources of the authorized calendar.
- **iCloud cannot restore individual deleted events** (there are only backups of the whole account). Hence: a result with the full event for `create_event`, and an `.ics` backup.
- Backup: `~/Library/Application Support/icloud-mcp/deleted/YYYY-MM-DD_HHMMSS_Title.ics`, folder 0700, files 0600, read back after writing as a check. Cleanup on every deletion:
  older than 90 days (file modification time) or beyond the 200 newest; only files matching our own naming pattern.
- **Measured live on 2026-10-08** (with our own test event in a test calendar): create, then deletion attempts with wrong title, wrong start time and stale ETag (all refused, the event remained), then the real deletion.
  iCloud accepted `DELETE` with `If-Match` on the ETag from the GET (2xx); the event was gone afterwards, and a second deletion reported "not found". The backup (3 KB, permissions 600, folder 700) contained `VEVENT`, the title and both `VALARM`s.
  The event could be recreated from the result with `create_event` (title, start, end, location and notes identical) and deleted again.
- Still open: restoring the `.ics` by double-click in Apple Calendar, and the server-side behaviour of `DELETE` with a stale ETag (HTTP 412 is only verified against a local test server; live, the ETag check before deletion already catches it).

## Moving to the Trash (0.2.0)

Decisions (implemented, tested against test servers with the real `imapflow`, `test/trash.test.ts`; `UID MOVE` itself verified live, for the full `trash_message` path against iCloud see below):

- Moving uses only `UID MOVE` from a folder opened read-write (`SELECT`), sent directly (`exec`), not via `imapflow.messageMove`. The check before moving (subject, sender) runs read-only (`EXAMINE`, headers and flags only).
- **Finding:** when the `MOVE` capability is missing, `imapflow.messageMove` silently falls back to `COPY`, setting `\Deleted` and `EXPUNGE`. That is forbidden, and iCloud doesn't advertise `MOVE` (see below). That's why `messageMove` is not used anywhere;
  `moveToTrash` sends `UID MOVE` directly. If the server refuses, the call aborts with a clear message. Tests: a server that understands and advertises `MOVE`; a server that understands it but doesn't advertise it (like iCloud); a server that doesn't understand it.
  In all cases, `COPY`, `STORE`, `\Deleted` or `EXPUNGE` are never sent. Counter-check: with `messageMove` built in, four network tests and the source guard fail.
- **Finding:** `imapflow` determines special-use folders by name when the server doesn't offer `SPECIAL-USE` (iCloud doesn't advertise it). The Trash is therefore recognized directly by the `\Trash` flag in the LIST response
  (`MailboxInfo.roleBy === 'flag'`). A folder named "Trash" without the flag doesn't count; several folders with the flag count as ambiguous.
- Mails in the Trash are never touched, at most 20 mails per call, all or nothing: if subject or sender doesn't match for one mail, none is moved. Error messages don't reproduce any mail content.
- Subject comparison ignores case and whitespace, also in the form truncated to 300 characters. Sender: if the given value contains an address, exactly that address must match, otherwise the display name.
- **iCloud's MOVE capability (measured live on 2026-10-08 with `npm run imap-capabilities`, CAPABILITY and LIST only): NO.** After sign-in, iCloud lists 21 capabilities:
  `CONDSTORE CONTEXT=SORT ENABLE ESEARCH ESORT ID IDLE IMAP4 IMAP4rev1 LIST-STATUS NAMESPACE QRESYNC QUOTA SASL-IR SORT UIDPLUS UNSELECT WITHIN X-APPLE-REMOTE-LINKS XAPPLELITERAL XAPPLEPUSHSERVICE`.
  Neither `MOVE` nor `SPECIAL-USE` nor `XLIST`. The Trash "Deleted Messages" does carry the `\Trash` flag, though, and is found that way.
  **However:** iCloud **still understands `UID MOVE`** (verified live on 2026-10-08): a test draft was moved from "Drafts" with `UID MOVE <uid> "Deleted Messages"` (response `OK`, "completed", around 190 ms; Drafts 1 → 0, Trash 8 → 9;
  only this one command was sent, no `COPY`, `STORE`, `\Deleted` or `EXPUNGE`). The capability list is therefore not a reliable indicator here; `trash_message` doesn't query it but tries `UID MOVE` and aborts if it is refused.
- **Full path tested live on 2026-10-08** (`TrashService` and `ImapGateway` against iCloud, with a test draft to the own address, not sent): the Trash "Deleted Messages" was recognized by the `\Trash` flag.
  Wrong subject and wrong sender were refused (the draft remained in the Drafts folder, counters unchanged). The real move worked (Drafts 1 → 0, Trash 11 → 12); the mail could then be found in the Trash and stayed "read"
  (the draft carries `\Seen`; checking the headers marks nothing). A new attempt with the mail in the Trash was refused, and so were 21 mails (without network access).
- Recoverability of "about 30 days" in the Trash is taken from the original specification; it has not been measured.

## Claude Desktop: per-tool approval, installing over an existing version (researched 2026-10-08)

- Anthropic's help articles describe approval levels for connector tools ("Always allow", "Needs approval", "Blocked") in the context of Cowork (selected via the plus menu or *Customize > Connectors*).
  Whether and where exactly local extensions show these levels under *Settings > Extensions* isn't stated there; the README describes the interface as the specification names it, and it should be checked on update.
- **Scheduled tasks and "Needs approval":** there is no explicit statement. A bug report ([anthropics/claude-code issue 60443](https://claudeissues.com/issue/60443-bug-create-scheduled-task-blocked-by-permissionmode-gate-in-1-7196-0-mcp-unusabl))
  shows that tools requiring approval are rejected in unattended runs as "unavailable in unsupervised mode". The README therefore phrases it as a consequence of the per-tool approval, not as a guaranteed property.
- **Installing a new `.mcpb` over an existing version:** neither the help article "Getting started with Local MCP servers on Claude Desktop" nor Anthropic's engineering post on Desktop Extensions nor the README of the mcpb repository says whether the extension is replaced
  and whether the settings are kept. Documented: directory extensions update automatically, private extensions are installed manually with new `.mcpb` files.
- **Observation on a Mac with the extension installed** (only names and structure inspected, no values): the extension is registered as `local.mcpb.<author>.icloud-connector` (identifier from author and name; both stay the same in 0.2.0).
  Program files are in `Claude Extensions/<identifier>/`, installation details in `extensions-installations.json` (version, checksum, manifest), the settings (`isEnabled`, `userConfig`) in `Claude Extensions Settings/<identifier>.json`.
  So the settings are separate from the program files and bound to the identifier. **Whether the installer keeps them when installing over an existing version is not established**; the README says so and advises keeping the password at hand.

## Claude Desktop: elicitation (confirmation before writing)

We checked whether Claude Desktop supports MCP elicitation, so that writes to shared calendars could be confirmed beforehand via a prompt.

- The official MCP client overview lists elicitation **only for Claude Code** (since version 2.1.76). For Claude Desktop it lists **Roots**, not elicitation ([change in the MCP repository, merged on 2026-03-14](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2398)).
- A bug report shows that Claude Desktop (Cowork) answers `elicitation/create` immediately with `cancel` without showing anything, while the same server works in Claude Code ([anthropics/claude-code#56243](https://github.com/anthropics/claude-code/issues/56243), closed as a duplicate of the open feature request #2799).

**Decision:** Claude Desktop does not reliably support elicitation (as of 2026-10-08). The existing rule stays:
a shared calendar is only written to when it is named explicitly with `shared_calendar="<name>"`; otherwise the request is refused.
Elicitation is therefore not built in. Should this change, an additional confirmation prompt would be an addition that does not replace this rule.

## Packaging as a Desktop Extension (.mcpb)

- Manifest version 0.3 (like the extensions already installed on this Mac). The `mcpb` tool (2.1.2) knows 0.1 to 0.4.
- Claude Desktop starts Node extensions with its **built-in Node** ("Using built-in Node.js for MCP server" in the log), currently Electron 44.
  Nothing needs to be installed. The code requires Node >= 20 (requirement of `imapflow`) and is tested with Node 25.9.
- `npm run build:mcpb` bundles the server with esbuild into **one** file (`server/index.mjs`, around 5 MB unpacked, 1.1 MB packed), places manifest and icon next to it,
  validates with `mcpb validate`, packs with `mcpb pack` and checks the package (only expected files, no `.env`, no credentials from `.env` in the package).
- According to [Anthropic](https://www.anthropic.com/engineering/desktop-extensions), Claude Desktop stores sensitive settings (`sensitive: true`) in the macOS Keychain and passes them on as environment variables.
  Optional fields left empty may arrive as an unreplaced placeholder (`${user_config.…}`); `loadConfig` treats that as empty.
- **Don't:** run the Claude app itself in Node mode (`ELECTRON_RUN_AS_NODE=1 …/Claude -e …`). The mode is disabled; the call starts a
  **second app instance** instead. This happened during testing and was ended immediately. Plain Node is enough for testing (`scripts/dev-bundle.sh`).
- Privacy note: Claude Desktop logs the MCP messages in `~/Library/Logs/Claude/mcp-server-*.log`, **including the results** (events, mail text).
  The connector itself writes no content to the log, but the app does.

## Scheduled tasks and phone (clarified 2026-10-09, in the README)

- **Phone, tested in practice on 2026-10-08:** from the Claude app on the iPhone, in a conversation connected to the Mac, `list_calendars`, `unread_counts`, `list_events` and `create_event` worked, including with `shared_calendar` and for many events in a row. Condition: Mac awake, Claude Desktop open.
- **Scheduled tasks:** [Anthropic's documentation on local scheduled tasks in Claude Desktop](https://code.claude.com/docs/en/desktop-scheduled-tasks) (retrieved 2026-10-09) states explicitly: runs only take place while the app is running and the computer is awake; a slot missed during sleep is skipped, and on wake there is at most one catch-up run for the last seven days; *Keep computer awake* (Settings > Desktop app > General) prevents idle sleep, but not a closed lid; a run that needs an approval stops until someone answers. The earlier contradiction between help articles concerned tasks that don't need local tools; for this local connector, the statement above applies.
- **Not tested:** a scheduled task with this connector. The README says so.

## Live test "reading changes nothing" on iCloud (2026-10-08)

With a deliberately unread mail in the inbox: read with `get_message` (text and Markdown), `get_thread` and `search_messages`;
afterwards the flags of 56 messages (Inbox, Sent, Drafts, Archive, Trash, Junk) were identical, the mail was still unread,
and the server still reported 1 unread message.
