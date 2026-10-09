# Entwicklung

Hinweise für alle, die den Konnektor weiterentwickeln, ob von Hand oder mit einem Coding-Agenten. Gemessene iCloud-Eigenheiten und die Begründung einzelner Entscheidungen stehen in [`ICLOUD-NOTIZEN.md`](ICLOUD-NOTIZEN.md).

## Befehle

```bash
npm install
cp .env.example .env        # Zugangsdaten selbst eintragen, nie in einen Chat schreiben
npm run typecheck
npm test                    # ohne Netzwerk (simulierter Kalender- und IMAP-Server)
npm run build:mcpb          # baut dist/icloud-mcp-<Version>.mcpb (prüft Manifest und Paketinhalt)
scripts/call.sh <werkzeug> key=value ...   # ruft ein Werkzeug über den MCP Inspector auf (Server aus src, Werte aus .env)
scripts/dev-bundle.sh       # startet das gebündelte Paket
npm run feasibility         # kleiner Anmeldetest (listet Kalender, Adressbücher, Ordner)
npm run imap-capabilities   # Fähigkeiten von iCloud-Mail nach der Anmeldung und Ordner-Merkmale (rein lesend)
```

## Aufbau

```
manifest.json            Desktop-Extension-Manifest (0.3), user_config, Werkzeugliste
src/core/                Fachlogik, kennt MCP nicht (für einen späteren gehosteten Konnektor wiederverwendbar)
  calendar/ contacts/ mail/   je Zugriff (tsdav / imapflow), Verarbeitung, Service
  permissions.ts         zentrale Rechteprüfung (WriteGrant für Anlegen/Ändern/Löschen, DraftGrant, TrashGrant)
  calendar/backup.ts     .ics-Sicherung vor dem Löschen, Aufräumen (90 Tage / 200 Dateien)
  mail/trash.ts          trash_message: Prüfung von Betreff und Absender, dann Verschieben
  untrusted.ts           Abgrenzung fremder Daten, structuredContent
src/mcp/                 dünne MCP-Schicht: Werkzeuge, Zod-Schemas, Annotationen
src/stdio.ts             Einstiegspunkt (stdio)
test/                    Tests; test/miniImap.ts ist ein simulierter IMAP-Server, der iCloud-Eigenheiten nachbildet und jeden Befehl protokolliert
docs/ICLOUD-NOTIZEN.md   gemessene iCloud-Eigenheiten und Entscheidungen
```

## Sicherheitsregeln

Diese Regeln sind der Kern des Projekts. Sie werden im Code durchgesetzt, nicht nur in Werkzeugbeschreibungen, und Tests bewachen sie. Wer sie ändert, ändert die Zusage an die Nutzer.

- **Rechte im Code:** Schreibende Methoden verlangen ein Grant aus `src/core/permissions.ts`. Tool-Annotationen (`readOnlyHint`, `destructiveHint`) müssen stimmen.
- **Löschen nur auf zwei Wegen:** `delete_event` (eigener Termin, vorher `.ics`-Sicherung; nie mit Teilnehmern, fremdem Organisator, in geteilten Kalendern oder als einzelnes Vorkommen) und `trash_message` (per IMAP `UID MOVE` in den Ordner mit dem Merkmal `\Trash`, höchstens 20, Betreff und Absender werden geprüft; nie `\Deleted`, nie `EXPUNGE`). Der Test »nur die zwei erlaubten Wege« in `test/permissions.test.ts` bewacht das im Quelltext.
- **Kein Senden:** kein SMTP im Code, kein Markieren von Mails, Kontakte nur lesend.
- **Keine Einladungen:** `create_event` und `update_event` setzen keine Teilnehmer. Termine mit Teilnehmern oder fremdem Organisator werden nicht geändert, bei Serien nur die ganze Serie.
- **Geteilte Kalender** (in `list_calendars` mit `shared: true`) nur mit ausdrücklichem `shared_calendar="<Name>"`. Praxistests nie in geteilten Kalendern.
- **Mail lesen ohne Nebenwirkung:** Ordner schreibgeschützt öffnen (`EXAMINE`) und `BODY.PEEK`. Entwürfe nur per `APPEND` mit `\Draft` in den Entwürfe-Ordner.
- **Fremde Daten:** Mail- und Termininhalte als Fremdinhalt abgegrenzt ausgeben. Keine Inhalte und keine Zugangsdaten in Logs, Fehlermeldungen bereinigen.
- **Zugangsdaten** nur als `user_config` mit `sensitive: true` (macOS-Schlüsselbund) bzw. lokal in `.env`, die nie eingecheckt wird. Login für CalDAV/CardDAV (Apple-ID) und IMAP (`@icloud.com`) getrennt.
- Die interne Kennung der Erweiterung (`name: icloud-connector` im Manifest) nicht ändern. Sonst entsteht beim Update eine zweite, leere Erweiterung. `test/manifest.test.ts` bewacht das.

## Bekannte Fallen

- **Die Claude-App nie im Node-Modus aufrufen** (`ELECTRON_RUN_AS_NODE`). Der Modus ist gesperrt, es startet eine zweite App-Instanz. Zum Testen reicht normales Node (`scripts/dev-bundle.sh`).
- **iCloud:** `allprop` liefert keine Kalenderdaten. Die Kopfzeilen-Suche braucht `<id>` mit spitzen Klammern. TEXT-Suche findet MIME-kodierte Betreffs nicht. ETags stehen in Anführungszeichen, Clients verlieren sie gelegentlich (wird normalisiert).
- **imapflow weicht ohne angebotene `MOVE`-Fähigkeit stillschweigend auf `COPY` + `\Deleted` + `EXPUNGE` aus** (`messageMove`), und iCloud bietet `MOVE` nicht an, versteht es aber. Deshalb sendet `moveToTrash` `UID MOVE` direkt per `exec`. `messageMove` darf nirgends im Code vorkommen (Wächtertest).
- imapflow rät Spezialordner nach dem **Namen**, wenn der Server `SPECIAL-USE` nicht anbietet (bei iCloud der Fall). Die Rolle `trash` zählt deshalb nur, wenn das Merkmal `\Trash` in der LIST-Antwort steht (`roleBy: 'flag'`).
- Der MCP-Inspector liest `--tool-arg`-Werte als JSON. In der Shell kann `echo` ein `\n` in JSON zerstören, besser `printf '%s'`.
- `timeout` gibt es auf macOS nicht. Für Rauchtests des Pakets ein kleines Node-Skript verwenden (Paket entpacken, `server/index.mjs` mit Dummy-Zugangsdaten starten, `tools/list` abfragen).
- Unsignierte Erweiterungen zeigen bei der Installation einen Hinweis. Das ist bei einer selbst gebauten Erweiterung normal.

## Releases

Version in `package.json` erhöhen (das Build-Skript übernimmt sie ins Manifest), `npm test`, `npm run build:mcpb`, dann die Datei aus `dist/` an einen GitHub-Release mit dem Tag `v<Version>` hängen. Die `.mcpb` gehört nicht ins Repository.
