# Privacy

iClaude runs only on your Mac, inside Claude Desktop. It has no server of its own, no telemetry and no analytics. The author never receives any data.

## What iClaude accesses

When Claude calls one of its tools, iClaude connects directly to Apple's iCloud servers (CalDAV for calendars, CardDAV for contacts, IMAP for mail; PDF text of attachments is extracted locally) over TLS, signed in with the app-specific password you entered. It reads or writes only what the called tool needs.

For **Apple Reminders and Notes** iClaude makes no network connection at all. It asks the Reminders and Notes apps on your Mac, through macOS automation (`osascript`), to read or write. macOS shows a one-time permission question for each app; you can revoke it in System Settings > Privacy & Security > Automation. What the apps sync with iCloud is done by the apps themselves, not by iClaude.

## Where data goes

- **To Claude:** tool results (events, contacts, mail content, reminders, notes) are returned to Claude Desktop and processed by Anthropic like any other chat content. Anthropic's privacy policy applies to that.
- **Credentials:** stored by Claude Desktop in the macOS Keychain. iClaude never writes them anywhere and never includes them in error messages.
- **On your Mac:** before deleting or moving an event, iClaude saves it as an `.ics` file in `~/Library/Application Support/icloud-mcp/deleted/`, and before changing a contact it saves the card as a `.vcf` file in `~/Library/Application Support/icloud-mcp/contacts-backup/` (both kept 90 days, at most 200 files each). Nothing else is stored; reminders and notes are not copied anywhere.
- **Logs:** iClaude itself writes no content to logs. Claude Desktop logs the messages between Claude and the extension, including results, in `~/Library/Logs/Claude/`.

## Removing everything

Uninstall the extension in Claude Desktop, revoke the app-specific password at account.apple.com and, if you like, delete `~/Library/Application Support/icloud-mcp/`.
