<p align="center"><img src="assets/icon.png" width="140" alt="iClaude logo: a cloud in Claude orange"></p>

# iClaude: iCloud connector for Claude Desktop

A local MCP server (packaged as a Desktop Extension) for iCloud Calendar, Contacts and Mail. It runs only on your Mac. There is no server on the internet.

[Deutsch](README.de.md)

**What it does and what it doesn't:**

- **Never sends.** Mails are only created as drafts (also forwards, with attachments) in the Drafts folder. You review and send them yourself in Apple Mail.
- **Never deletes mails permanently.** `trash_message` moves them to the Trash, where they can be recovered for about 30 days.
- **Deletes only your own events, and only with a backup.** `delete_event` first saves an `.ics` backup and returns the full event. Moving an event to another calendar removes the original only after the copy was created and read back, and also saves an `.ics` backup first.
- **Writes to shared calendars only when you name them explicitly.** Contacts are only created or changed on request (`update_contact` backs the card up first) and are never deleted. Invitations and attendees are not supported.

<details>
<summary>Contents</summary>

- [Requirements](#requirements)
- [Create an app-specific password](#create-an-app-specific-password)
- [Installation](#installation)
- [Tools](#tools)
- [Use from your phone and in scheduled tasks](#use-from-your-phone-and-in-scheduled-tasks)
- [Updating to a new version](#updating-to-a-new-version)
- [Backups of deleted events](#backups-of-deleted-events)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)
- [Development](#development)
- [License and trademarks](#license-and-trademarks)

</details>

## Requirements

- A Mac with **Claude Desktop**. You don't need to install Node.js, Claude Desktop ships with it.
- An **iCloud account** with Calendar, Contacts and Mail turned on.
- **Two-factor authentication** for your Apple ID. Without it, Apple doesn't offer app-specific passwords.

## Create an app-specific password

The connector signs in to iCloud with an **app-specific password**, never with your regular Apple ID password. It only works for this access and can be revoked individually at any time.

1. Open [account.apple.com](https://account.apple.com) and sign in.
2. **Sign-In and Security** → **App-Specific Passwords** → create a new password.
3. Give it a name you will recognize later, for example `iClaude Home Mac`.
4. Apple shows the password in the format `xxxx-xxxx-xxxx-xxxx` **only once**. Enter it straight into the installation dialog (see below).

Notes:

- **Never paste it into a chat**, not even into Claude. It belongs only in the installation dialog or, for development, in the local `.env`.
- Use one password per computer. That way you can lock out a single Mac without touching the others.
- **If you change your regular Apple ID password, Apple revokes all app-specific passwords.** Then create a new one and enter it in the extension settings.

## Installation

1. Download the latest `icloud-mcp-<version>.mcpb` from the [releases page](https://github.com/zoblon/iClaude/releases/latest).
2. Double-click the file. Claude Desktop opens the installation dialog. A notice that the extension is not signed is normal for a self-built extension.
3. Fill in the fields:

   | Field | Content |
   |---|---|
   | Apple ID (email address) | The email address of your Apple ID. User name for Calendar and Contacts. |
   | iCloud email address | Your `@icloud.com` address. User name for Mail, may differ from the Apple ID. |
   | App-specific password | The password from the previous section. Claude Desktop stores it in the macOS Keychain. |
   | Time zone | Defaults to `Europe/Berlin`. |
   | Default calendar for new events | Name of a **private event calendar**, for example `Home`. Not a reminders list and not a shared calendar. You can leave it empty; then every new event has to name a calendar. |

4. Enable the extension.
5. **Set the delete tools, `update_event`, `update_contact`, `move_message` and `set_message_flags` to require approval:** in *Settings > Extensions* (depending on the version *Customize > Connectors*), under **iClaude**, for the tools `delete_event`, `trash_message`, `update_event`, `update_contact`, `move_message` and `set_message_flags`. Claude then asks before every deletion, change, move or marking. (`update_event` also covers moving an event to another calendar, which removes the original from the old one.)
6. Try it, for example with "Which calendars can you see?" and "What's on this week?". Shared calendars are marked as shared in the answer.

The extension's interface (tool titles, descriptions, error messages) is in English. Claude still answers in your language.

## Tools

| Tool | Purpose | Access |
|---|---|---|
| `list_calendars`, `list_events`, `search_events`, `find_free_slots` | Read calendars | read-only |
| `create_event`, `update_event` | Create and change events, change a single occurrence of a series, move an event to another calendar | write; shared calendars only with `shared_calendar`; no attendees; a move removes the original (see below) |
| `import_invitation` | Add an invitation from a mail as your own event | write, only in a private calendar; no attendees, no reply |
| **`delete_event`** | Delete one of your own events | **delete** (see below) |
| `search_contacts`, `get_contact`, `list_contact_groups`, `upcoming_contact_dates` | Read contacts, groups, upcoming birthdays and anniversaries | read-only |
| `create_contact` | Create one contact (checks for duplicates first) | write; never changes existing contacts |
| **`update_contact`** | Change one contact | **write**, `.vcf` backup first (see below) |
| `list_mailboxes`, `unread_counts`, `list_recent`, `search_messages`, `get_message`, `get_thread`, `read_attachment` | Read mail and attachments (text, PDF text, calendar invitations); nothing is marked as read | read-only |
| `create_draft` | Create a draft, a reply draft or a forward draft (with the original's attachments) | write, only in the Drafts folder |
| **`move_message`** | Move mails to another folder (not the Trash, Drafts, Sent or Junk) | **move** (see below) |
| **`set_message_flags`** | Mark mails read/unread or flagged/not flagged | **write**, only these two marks |
| **`trash_message`** | Move mails to the Trash | **move** (see below) |

Events with attendees and events organized by someone else are never changed or moved. For recurring series, a single occurrence can be changed (`occurrence_start`) and the whole series can be changed, moved or deleted; single occurrences are never deleted.

### `delete_event`: delete an event

Required: the event's `id`, `title` and `start`. The server loads the event and compares title and start time. If anything doesn't match, nothing is deleted.
Deletion uses `DELETE` with `If-Match` on the ETag: if the event has changed in the meantime, iCloud refuses.

Refused:

- events with attendees or events organized by another person, because iCloud could otherwise send cancellations,
- events in shared calendars, **even with `shared_calendar`**, which only applies to writing,
- single occurrences of a series. Only the whole series can be deleted; then `start` is the start of the first event,
- events as part of a move: see below.

**iCloud itself cannot restore individual deleted events.** That's why there are two ways back:

1. The result contains the full event (title, start, end, all-day, location, notes, alerts, recurrence rule, calendar). Claude can use it to recreate the event with `create_event`.
   Anything that can't be represented that way, such as exceptions in a series, is listed under `restoreHints`.
2. Before deleting, the event is saved as an `.ics` file (see [Backups](#backups-of-deleted-events)). If the backup fails, nothing is deleted.

### `update_contact`: change a contact

Required: the contact's `id` and `name` (checked against the stored contact; if it doesn't match, nothing is changed), optionally the `etag` from `get_contact`. You can set simple fields (first and last name, company, department, job title, nickname, birthday, notes; an empty string removes the field) and add or remove emails, phone numbers, addresses and web addresses (removal by exact value). The result shows before and after of every changed field.

- The photo, group memberships, the UID and every field that isn't named stay exactly as they were: the card is edited line by line and is never re-serialized.
- Before writing, the card is saved as a `.vcf` file in `~/Library/Application Support/icloud-mcp/contacts-backup/` (90 days, at most 200 files, readable only by you). If the backup fails, nothing is changed. To restore, import the `.vcf` in Apple Contacts.
- Writing uses `If-Match` on the ETag. Contacts and groups are never deleted, and group cards are never written.
- `create_contact` refuses to create a contact when one with the same email address, phone number (last 8 digits) or full name exists, and returns the matches instead (unless `allow_duplicate` is true).

### `update_event`: single occurrences, moving to another calendar; `import_invitation`

- **One occurrence of a series:** with `occurrence_start` (the occurrence's start exactly as `list_events` shows it in `occurrenceStart`), only that occurrence changes: title, start/end, location, notes, alerts. It is stored as an exception (an override with `RECURRENCE-ID`) inside the same event; the series and the other exceptions stay as they are. Refused for events with attendees or another organizer, shared calendars without `shared_calendar`, and occurrences the series doesn't have (also deleted ones). A single occurrence can be moved to another time, but not deleted.
- **Move to another calendar:** `move_to_calendar` names one of your **private** calendars (a shared target only together with its exact name in `shared_calendar`). It is a step of its own (no other fields in the same call). First an `.ics` backup is saved, then the event is created in the target calendar and read back and compared, and only then is the original deleted with `If-Match`. If the deletion fails, both places are reported and nothing more happens. Refused: out of shared calendars, events with attendees or another organizer, single occurrences. If the target calendar doesn't accept the old UID, the event gets a new one.
- **`import_invitation`** (mail `id`, `attachment_id` of the `.ics`, optional private `calendar`) creates your own event from an invitation: title, time, location, description, recurrence and reminders. Attendees, organizer and method are removed; the organizer appears only as text in the notes. **No reply is sent to the sender.** If an event with the same UID (or an earlier import of this invitation) exists in any calendar, nothing is created and the existing event is returned. A series with changed occurrences is imported completely or refused.

### `trash_message`: move mails to the Trash

Required for each mail: `id`, `subject` and `from` (sender). Before moving, the server checks that both match the mail. If even one mail doesn't match, **nothing** is moved.
At most 20 mails per call.

- The Trash is found by its `\Trash` flag, never by name.
- Mails are moved with IMAP `UID MOVE`. `\Deleted` is never set and `EXPUNGE` is never sent. iCloud doesn't list `MOVE` in its capabilities, but understands the command (verified on 2026-10-08).
  If a server rejects `UID MOVE`, nothing happens. There is no fallback via the deleted flag and `EXPUNGE`.
- Mails that are already in the Trash are never touched. There is no permanent deletion.

### `read_attachment`, `move_message`, `set_message_flags` and forwarding

- **`read_attachment`** (mail `id`, `attachment_id` from `get_message`, optional `offset` for long texts) downloads only that one attachment (at most 15 MB, `BODY.PEEK`, nothing is marked as read). It reads text files (also CSV, and HTML as Markdown), PDFs (text is extracted on your Mac, no network; a scanned PDF without a text layer is reported as such, there is no OCR) and calendar invitations (`.ics`: title, start, end, location, organizer, method, recurrence, description). Images, Office files and ZIP files return only their metadata.
- **`move_message`** moves up to 50 mails into a folder (path, name, or the role `archive`). Required for each mail: `id`, `subject` and `from`; if one doesn't match, **nothing** is moved. The target must not be the Trash (that's what `trash_message` is for), Drafts, Sent or Junk, and not the folder the mail is already in. Mails are moved with a direct IMAP `UID MOVE`, without a fallback. The result contains each mail's new ID and folder, so the move can be undone.
- **`set_message_flags`** marks up to 50 mails read/unread and/or flagged/not flagged (`\Seen` and `\Flagged` are the only flags the code can set). Same check of `id`, `subject` and `from`; the result shows the previous state.
- **Forwarding:** `create_draft` with `forward_of_id` creates a draft "Fwd: …" with a forwarding block in the style of Apple Mail (From, Subject, Date, To) and the text of the original (`quote: false`: only the block). The original's attachments are taken along, all by default or those listed in `forward_attachment_ids`, up to 20 MB in total. It is still only a draft in the Drafts folder; you send it yourself.

## Use from your phone and in scheduled tasks

The connector runs **on your Mac**, as part of Claude Desktop. It is only reachable while the Mac is awake and Claude Desktop is running. There is no server on the internet that steps in.

**From the iPhone:** in a conversation connected to your Mac, you can also use the connector from the Claude app on the iPhone. Tested on 2026-10-08: reading calendars, counting mails and creating events, including in a shared calendar, worked from the iPhone while the Mac was running and Claude Desktop was open. If the Mac is asleep or turned off, or Claude Desktop has quit, Claude can't find the tools.

**Scheduled tasks**, such as a daily briefing from events and mails. According to [Anthropic's documentation on local scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks):

- They only run while Claude Desktop is running and the computer is awake. If the Mac sleeps through the scheduled time, the run is skipped.
- On wake, Claude Desktop catches up on at most **one** missed run from the last seven days. A briefing scheduled for 7 a.m. may then arrive around noon.
- The *Keep computer awake* setting (Settings > Desktop app > General) prevents idle sleep. Closing a MacBook lid still puts the Mac to sleep.
- If a run needs a tool that asks for approval, it waits until you answer.

For this project that means: reading, creating events and drafts work in scheduled tasks as long as the Mac is awake. `delete_event` and `trash_message` require approval and therefore only run once you confirm. So deletion only happens while you are there. A scheduled task with this connector has not been specifically tested yet.

## Updating to a new version

1. Download the new `.mcpb` from the releases page and open it with a double-click, as during installation. The extension keeps its internal identifier (`icloud-connector`), so no second extension is created.
2. Check in *Settings > Extensions* that the fields are still filled in. **Anthropic doesn't document whether settings are kept when installing over an existing version.** Claude Desktop stores them separately from the program files, but keep the app-specific password at hand or create a new one, just in case.
3. Check the permissions: `delete_event`, `trash_message`, `update_event`, `update_contact`, `move_message` and `set_message_flags` set to require approval, and set any newly added tools deliberately.

Since version 0.2.1 the extension is called **iClaude** in Claude Desktop; before that it was "iCloud: Kalender, Kontakte, Mail". Please update saved tasks or instructions that use the old name.

## Backups of deleted events

- Folder: `~/Library/Application Support/icloud-mcp/deleted/`, readable only by your user.
- File name: `YYYY-MM-DD_HHMMSS_Title.ics`, for example `2026-10-08_191530_Dentist.ics`.
- **Restore:** double-click the file. Apple Calendar asks which calendar the event should go into.
- **Cleanup:** on every deletion, backups older than 90 days are removed, and at most the 200 newest are kept. Other files in the folder are never touched.
- The backup contains the event's title, location and notes in plain text. A file is one to two kilobytes.

## Privacy

- **Credentials** are stored in the macOS Keychain. The connector doesn't write them anywhere and never includes them in error messages.
- **Content:** what Claude reads through the connector, i.e. events, contacts and mails, is sent to Anthropic and processed there like any other chat message. The connector itself only connects to iCloud servers.
- **Logs:** Claude Desktop logs the messages between Claude and the connector in `~/Library/Logs/Claude/mcp-server-*.log`, **including the results**, so event and mail content as well. The connector itself writes no content to the log, but the app does. If you share a log for troubleshooting, copy out only the status lines first.
- **Untrusted content:** the connector explicitly passes mail and event text to Claude as untrusted content, so that instructions inside a mail aren't treated as a request.

## Troubleshooting

| Problem | Cause and solution |
|---|---|
| Sign-in fails with an authentication error | Check that you entered the **app-specific** password and not your regular one. If the Apple ID password was changed or the app-specific password was revoked, create a new one and enter it in the extension settings. |
| Calendars work but mail doesn't (or vice versa) | The two user names are swapped or one is missing. Calendar and Contacts sign in with the Apple ID, Mail with the `@icloud.com` address. |
| "Calendar … not found" when creating an event | The default calendar is misspelled, belongs to a reminders list or no longer exists. The error message lists the private calendars; enter one of them in *Settings > Extensions > iClaude*. |
| "… is a shared calendar" | Intended. The connector only writes to shared calendars when you name the calendar explicitly, for example "add this to the <name> calendar". A shared calendar is not allowed as the default calendar. |
| An event can't be changed, moved or deleted | The event has attendees, was organized by someone else, is in a shared calendar (deleting and moving out of it are always refused; changing needs `shared_calendar`) or you asked to delete a single occurrence of a series. The message states the reason. Edit such events yourself in Apple Calendar. |
| Tools are missing in Claude | Is the extension enabled in *Settings > Extensions*? Quit Claude Desktop completely with ⌘Q and restart it. If that doesn't help, look for status lines such as start, connection and errors in `~/Library/Logs/Claude/mcp-server-*.log`. |
| No tools from the iPhone | The Mac is asleep or turned off, or Claude Desktop has quit. See [Use from your phone](#use-from-your-phone-and-in-scheduled-tasks). |
| A scheduled task didn't run | The Mac was asleep at the scheduled time. See [scheduled tasks](#use-from-your-phone-and-in-scheduled-tasks). |
| "Not signed" notice during installation | Normal for a self-built extension. |

## Uninstalling

1. In Claude Desktop, under *Settings > Extensions*, uninstall the **iClaude** extension.
2. On [account.apple.com](https://account.apple.com), under *Sign-In and Security > App-Specific Passwords*, revoke the password for iClaude.
3. Optionally delete the backups: the folder `~/Library/Application Support/icloud-mcp/`.
4. Optionally delete the logs that belong to iClaude: `~/Library/Logs/Claude/mcp-server-*.log`.

## Development

```bash
npm install
cp .env.example .env        # enter your credentials yourself, never paste them into a chat
npm run typecheck
npm test                    # no network needed (simulated calendar and IMAP server)
npm run build:mcpb          # builds dist/icloud-mcp-<version>.mcpb
```

Architecture, safety rules and known pitfalls: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Measured iCloud quirks and design decisions: [`docs/ICLOUD-NOTES.md`](docs/ICLOUD-NOTES.md).

## License and trademarks

MIT License, see [`LICENSE`](LICENSE). Use at your own risk.

iClaude is an independent project. It is not affiliated with, endorsed by or sponsored by Apple or Anthropic. iCloud is a trademark of Apple Inc., Claude is a trademark of Anthropic PBC.
