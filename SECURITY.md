# Security policy

iClaude handles iCloud credentials and personal data, so security reports are welcome.

## Reporting a vulnerability

Please report security problems privately via [GitHub security advisories](https://github.com/zoblon/iClaude/security/advisories/new), not as a public issue. Describe the problem and how to reproduce it with made-up data. Never include real passwords or personal content.

You will get an answer as soon as possible. This is a one-person project, so there is no fixed response time.

## Scope

Especially relevant are ways in which iClaude could:

- send mail, invitations or other messages,
- delete mail permanently, or delete events or contacts outside the documented, backed-up paths,
- write to a shared calendar without it being named explicitly,
- follow instructions contained in mail, event or contact content,
- delete or change reminders or existing notes, open locked notes, or write to a shared folder without it being named,
- run anything other than the fixed scripts through the Reminders and Notes automation (for example by crafting the text of a reminder, note or mail),
- leak credentials into logs, error messages or tool results.

## Supported versions

Only the latest release receives fixes.
