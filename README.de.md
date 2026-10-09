[English](README.md)

<p align="center"><img src="assets/icon.png" width="140" alt="iClaude-Logo: Wolke in Claude-Orange"></p>

# iClaude: iCloud-Konnektor für Claude Desktop

Lokaler MCP-Server (als Desktop Extension) für iCloud-Kalender, -Kontakte und -Mail. Er läuft nur auf deinem Mac, es gibt keinen Server im Internet.

Die Oberfläche der Erweiterung ist auf Englisch: Werkzeugtitel, Beschreibungen, Einstellungsfelder und Fehlermeldungen. Claude antwortet trotzdem in deiner Sprache.

**Was er tut und was nicht:**

- **Sendet nie.** Mails werden nur als Entwurf im Ordner »Entwürfe« angelegt. Du prüfst und sendest sie selbst in Apple Mail.
- **Löscht Mails nie endgültig.** `trash_message` verschiebt sie in den Papierkorb, dort sind sie etwa 30 Tage wiederherstellbar.
- **Löscht nur eigene Termine und nur mit Sicherung.** `delete_event` legt vorher eine `.ics`-Sicherung an und liefert den Termin vollständig zurück.
- **Schreibt in geteilte Kalender nur auf ausdrückliche Nennung.** Kontakte werden nur auf Anfrage angelegt oder geändert (`update_contact` sichert die Karte vorher) und nie gelöscht. Einladungen und Teilnehmer gibt es nicht.

<details>
<summary>Inhalt</summary>

- [Voraussetzungen](#voraussetzungen)
- [App-spezifisches Passwort erstellen](#app-spezifisches-passwort-erstellen)
- [Installation](#installation)
- [Werkzeuge](#werkzeuge)
- [Nutzung vom Handy und in geplanten Aufgaben](#nutzung-vom-handy-und-in-geplanten-aufgaben)
- [Update auf eine neue Version](#update-auf-eine-neue-version)
- [Sicherungen gelöschter Termine](#sicherungen-gelöschter-termine)
- [Datenschutz](#datenschutz)
- [Fehlerbehebung](#fehlerbehebung)
- [Deinstallation](#deinstallation)
- [Entwicklung](#entwicklung)
- [Lizenz und Marken](#lizenz-und-marken)

</details>

## Voraussetzungen

- Ein Mac mit **Claude Desktop**. Node.js musst du nicht installieren, Claude Desktop bringt es mit.
- Ein **iCloud-Konto** mit eingeschaltetem Kalender, Kontakte und Mail.
- **Zwei-Faktor-Authentifizierung** für deine Apple-ID. Ohne sie bietet Apple keine app-spezifischen Passwörter an.

## App-spezifisches Passwort erstellen

Der Konnektor meldet sich mit einem **app-spezifischen Passwort** bei iCloud an, nie mit deinem normalen Apple-ID-Passwort. Es gilt nur für diesen Zugang und lässt sich jederzeit einzeln widerrufen.

1. [account.apple.com](https://account.apple.com) öffnen und anmelden.
2. **Anmeldung und Sicherheit** → **App-spezifische Passwörter** → neues Passwort erstellen.
3. Einen Namen vergeben, an dem du es später wiedererkennst, zum Beispiel `iClaude Heim-Mac`.
4. Apple zeigt das Passwort im Format `xxxx-xxxx-xxxx-xxxx` **nur einmal** an. Trag es direkt im Installationsdialog ein (siehe unten).

Hinweise:

- **Nie in einen Chat schreiben**, auch nicht in Claude. Es gehört nur in den Installationsdialog oder, für die Entwicklung, in die lokale `.env`.
- Ein Passwort pro Rechner. Dann kannst du einen Mac einzeln sperren, ohne die anderen anzufassen.
- **Änderst du dein normales Apple-ID-Passwort, widerruft Apple alle app-spezifischen Passwörter.** Danach erstellst du ein neues und trägst es in den Einstellungen der Erweiterung ein.

## Installation

1. Die neueste `icloud-mcp-<Version>.mcpb` von der [Release-Seite](https://github.com/zoblon/iClaude/releases/latest) herunterladen.
2. Doppelklick auf die Datei. Claude Desktop öffnet den Installationsdialog. Ein Hinweis, dass die Erweiterung nicht signiert ist, ist bei einer selbst gebauten Erweiterung normal.
3. Die Felder ausfüllen (die Feldnamen zeigt der Dialog auf Englisch):

   | Feld | Inhalt |
   |---|---|
   | Apple ID (email address) | Die Mailadresse deiner Apple-ID. Benutzername für Kalender und Kontakte. |
   | iCloud email address | Deine `@icloud.com`-Adresse. Benutzername für Mail, kann von der Apple-ID abweichen. |
   | App-specific password | Das Passwort aus dem vorigen Abschnitt. Claude Desktop speichert es im macOS-Schlüsselbund. |
   | Time zone | Vorbelegt mit `Europe/Berlin`. |
   | Default calendar for new events | Name eines **privaten Termin-Kalenders**, zum Beispiel `Termine`. Keine Erinnerungsliste und kein geteilter Kalender. Leer lassen geht auch, dann muss jeder neue Termin einen Kalender nennen. |

4. Die Erweiterung einschalten.
5. **Die Löschwerkzeuge und `update_contact` auf »Nachfragen« stellen:** unter *Einstellungen → Erweiterungen* (je nach Version *Anpassen → Konnektoren*) bei **iClaude** die Werkzeuge `delete_event`, `trash_message` und `update_contact`. Dann fragt Claude vor jedem Löschen oder Ändern eines Kontakts nach und zeigt Titel und Startzeit, Betreff und Absender bzw. den Namen des Kontakts.
6. Testen, zum Beispiel mit »Welche Kalender siehst du?« und »Was steht diese Woche an?«. Geteilte Kalender sind in der Antwort als geteilt markiert.

## Werkzeuge

| Werkzeug | Zweck | Rechte |
|---|---|---|
| `list_calendars`, `list_events`, `search_events`, `find_free_slots` | Kalender lesen | nur lesen |
| `create_event`, `update_event` | Termine anlegen und ändern | schreiben; geteilte Kalender nur mit `shared_calendar`; keine Teilnehmer |
| **`delete_event`** | eigenen Termin löschen | **löschen** (siehe unten) |
| `search_contacts`, `get_contact`, `list_contact_groups`, `upcoming_contact_dates` | Kontakte, Gruppen und anstehende Geburtstage und Jahrestage lesen | nur lesen |
| `create_contact` | einen Kontakt anlegen (prüft vorher auf Dubletten) | schreiben; ändert nie vorhandene Kontakte |
| **`update_contact`** | einen Kontakt ändern | **schreiben**, vorher `.vcf`-Sicherung (siehe unten) |
| `list_mailboxes`, `unread_counts`, `list_recent`, `search_messages`, `get_message`, `get_thread` | Mail lesen, nichts wird als gelesen markiert | nur lesen |
| `create_draft` | Entwurf oder Antwort-Entwurf anlegen | schreiben, nur im Ordner »Entwürfe« |
| **`trash_message`** | Mails in den Papierkorb verschieben | **verschieben** (siehe unten) |

Termine mit Teilnehmern oder von anderen organisierte Termine werden nie geändert. Bei Serien lässt sich nur die ganze Serie ändern oder löschen, keine einzelnen Vorkommen.

### `delete_event`: Termin löschen

Pflichtangaben: `id`, `title` und `start` des Termins. Der Server lädt den Termin und vergleicht Titel und Startzeit. Passt etwas nicht, wird nichts gelöscht.
Gelöscht wird per `DELETE` mit `If-Match` auf das ETag: Hat sich der Termin inzwischen geändert, lehnt iCloud ab.

Abgelehnt werden:

- Termine mit Teilnehmern oder von einer anderen Person organisierte Termine, weil iCloud sonst Absagen verschicken könnte,
- Termine in geteilten Kalendern, **auch mit `shared_calendar`**, das gilt nur fürs Schreiben,
- einzelne Vorkommen einer Serie. Nur die ganze Serie lässt sich löschen, dann ist `start` der Beginn des ersten Termins.

**iCloud selbst kann einzelne gelöschte Termine nicht wiederherstellen.** Deshalb gibt es zwei Wege zurück:

1. Das Ergebnis enthält den Termin vollständig (Titel, Start, Ende, ganztägig, Ort, Notiz, Erinnerungen, Wiederholungsregel, Kalender). Claude kann ihn damit per `create_event` neu anlegen.
   Was sich so nicht abbilden lässt, etwa Ausnahmen einer Serie, steht unter `restoreHints`.
2. Vorher wird der Termin als `.ics` gesichert (siehe [Sicherungen](#sicherungen-gelöschter-termine)). Schlägt die Sicherung fehl, wird nicht gelöscht.

### `update_contact`: Kontakt ändern

Pflicht: `id` und `name` des Kontakts (wird gegen den gespeicherten Kontakt geprüft; passt er nicht, wird nichts geändert), optional das `etag` aus `get_contact`. Einfache Felder lassen sich setzen (Vor- und Nachname, Firma, Abteilung, Position, Spitzname, Geburtstag, Notizen; ein leerer Text entfernt das Feld). E-Mail-Adressen, Telefonnummern, Adressen und Webadressen lassen sich hinzufügen oder per exaktem Wert entfernen. Das Ergebnis zeigt Vorher und Nachher jedes geänderten Felds.

- Foto, Gruppenzugehörigkeit, UID und alle Felder, die nicht genannt werden, bleiben unverändert: Die Karte wird zeilenweise bearbeitet und nie neu serialisiert.
- Vor dem Schreiben wird die Karte als `.vcf` in `~/Library/Application Support/icloud-mcp/contacts-backup/` gesichert (90 Tage, höchstens 200 Dateien, nur für dich lesbar). Scheitert die Sicherung, wird nichts geändert. Zum Wiederherstellen die `.vcf` in Apple Kontakte importieren.
- Geschrieben wird mit `If-Match` auf das ETag. Kontakte und Gruppen werden nie gelöscht, Gruppenkarten nie beschrieben.
- `create_contact` legt keinen Kontakt an, wenn es schon einen mit gleicher E-Mail-Adresse, Telefonnummer (letzte 8 Ziffern) oder gleichem vollständigen Namen gibt, und liefert stattdessen die Treffer (außer bei `allow_duplicate: true`).

### `trash_message`: Mails in den Papierkorb

Pflichtangaben je Mail: `id`, `subject` (Betreff) und `from` (Absender). Der Server prüft vor dem Verschieben, dass beides zur Mail passt. Passt auch nur eine Mail nicht, wird **nichts** verschoben.
Höchstens 20 Mails pro Aufruf.

- Der Papierkorb wird über das Merkmal `\Trash` gefunden, nie über den Namen.
- Verschoben wird per IMAP `UID MOVE`. Es wird nie `\Deleted` gesetzt und nie `EXPUNGE` gesendet. iCloud nennt `MOVE` nicht in seiner Fähigkeitenliste, versteht den Befehl aber (am 8.10.2026 geprüft).
  Lehnt ein Server `UID MOVE` ab, passiert nichts. Einen Ausweg über Löschmarkierung und `EXPUNGE` gibt es nicht.
- Mails, die schon im Papierkorb liegen, werden nie angefasst. Ein endgültiges Löschen gibt es nicht.

## Nutzung vom Handy und in geplanten Aufgaben

Der Konnektor läuft **auf deinem Mac**, als Teil von Claude Desktop. Er ist also nur erreichbar, wenn der Mac wach ist und Claude Desktop läuft. Einen Server im Internet, der stellvertretend einspringt, gibt es nicht.

**Vom iPhone:** In einer Unterhaltung, die mit deinem Mac verbunden ist, kannst du den Konnektor auch aus der Claude-App auf dem iPhone nutzen. Am 8.10.2026 getestet: Kalender lesen, Mails zählen und Termine anlegen, auch in einem geteilten Kalender, funktionierten vom iPhone aus, während der Mac lief und Claude Desktop geöffnet war. Ist der Mac im Ruhezustand, ausgeschaltet oder Claude Desktop beendet, findet Claude die Werkzeuge nicht.

**Geplante Aufgaben**, etwa ein tägliches Briefing aus Terminen und Mails. Laut der [Anthropic-Dokumentation zu lokalen geplanten Aufgaben](https://code.claude.com/docs/en/desktop-scheduled-tasks) gilt:

- Sie laufen nur, wenn Claude Desktop läuft und der Rechner wach ist. Verschläft der Mac den Zeitpunkt, fällt der Lauf aus.
- Beim Aufwachen holt Claude Desktop höchstens **einen** verpassten Lauf der letzten sieben Tage nach. Ein Briefing für 7 Uhr kann dann also erst mittags kommen.
- Die Einstellung *Keep computer awake* (Einstellungen → Desktop app → General) verhindert den Ruhezustand bei Untätigkeit. Ein zugeklappter MacBook-Deckel schickt den Mac trotzdem schlafen.
- Braucht ein Lauf ein Werkzeug, das nach Freigabe fragt, bleibt er hängen, bis du die Rückfrage beantwortest.

Für dieses Projekt heißt das: Lesen, Termine anlegen und Entwürfe funktionieren in geplanten Aufgaben, solange der Mac wach ist. `delete_event` und `trash_message` stehen auf »Nachfragen« und laufen deshalb nur, wenn du die Rückfrage bestätigst. Gelöscht wird also nur, wenn du dabei bist. Eine geplante Aufgabe mit diesem Konnektor ist bisher nicht eigens getestet.

## Update auf eine neue Version

1. Die neue `.mcpb` von der Release-Seite herunterladen und wie bei der Installation per Doppelklick öffnen. Die Erweiterung behält ihre interne Kennung (`icloud-connector`), es entsteht also keine zweite Erweiterung.
2. Unter *Einstellungen → Erweiterungen* prüfen, ob die Felder noch gefüllt sind. **Anthropic dokumentiert nicht, ob die Einstellungen beim Überinstallieren erhalten bleiben.** Claude Desktop speichert sie zwar getrennt von den Programmdateien, halte zur Sicherheit aber das App-Passwort bereit oder erstelle ein neues.
3. Die Freigaben prüfen: `delete_event` und `trash_message` auf »Nachfragen«, neu hinzugekommene Werkzeuge bewusst einstellen.

Seit Version 0.2.1 heißt die Erweiterung in Claude Desktop **iClaude**, vorher »iCloud: Kalender, Kontakte, Mail«. Gespeicherte Aufgaben oder Anweisungen, die den alten Namen nennen, bitte anpassen.

## Sicherungen gelöschter Termine

- Ordner: `~/Library/Application Support/icloud-mcp/deleted/`, nur für deinen Benutzer lesbar.
- Dateiname: `JJJJ-MM-TT_HHMMSS_Titel.ics`, zum Beispiel `2026-10-08_191530_Zahnarzt.ics`.
- **Wiederherstellen:** Doppelklick auf die Datei. Apple Kalender fragt, in welchen Kalender der Termin soll.
- **Aufräumen:** Bei jedem Löschen werden Sicherungen entfernt, die älter als 90 Tage sind, und es bleiben höchstens die 200 neuesten. Andere Dateien im Ordner werden nie angefasst.
- Die Sicherung enthält Titel, Ort und Notiz des Termins im Klartext. Eine Datei ist ein bis zwei Kilobyte groß.

## Datenschutz

- **Zugangsdaten** liegen im macOS-Schlüsselbund. Der Konnektor schreibt sie nirgends hin und nennt sie in keiner Fehlermeldung.
- **Inhalte:** Was Claude über den Konnektor liest, also Termine, Kontakte und Mails, wird wie jede andere Chatnachricht an Anthropic übertragen und dort verarbeitet. Der Konnektor selbst verbindet sich nur mit den Servern von iCloud.
- **Protokolle:** Claude Desktop protokolliert die Nachrichten zwischen Claude und dem Konnektor in `~/Library/Logs/Claude/mcp-server-*.log`, **einschließlich der Ergebnisse**, also auch Termin- und Mailinhalte. Der Konnektor selbst schreibt keine Inhalte ins Protokoll, die App aber schon. Wer ein Protokoll zur Fehlersuche weitergibt, kopiert vorher nur die Statuszeilen heraus.
- **Fremde Inhalte:** Mail- und Termintexte gibt der Konnektor ausdrücklich als Fremdinhalt an Claude weiter, damit Anweisungen in einer Mail nicht als Auftrag verstanden werden.

## Fehlerbehebung

| Problem | Ursache und Lösung |
|---|---|
| Anmeldung schlägt fehl, Meldung zur Authentifizierung | Prüfen, ob das **app-spezifische** Passwort eingetragen ist und nicht das normale. Wurde das Apple-ID-Passwort geändert oder das App-Passwort widerrufen, ein neues erstellen und in den Einstellungen der Erweiterung eintragen. |
| Kalender gehen, Mail nicht (oder umgekehrt) | Die beiden Benutzernamen sind vertauscht oder einer fehlt. Kalender und Kontakte melden sich mit der Apple-ID an, Mail mit der `@icloud.com`-Adresse. |
| »Calendar … not found« beim Anlegen | Der Standardkalender ist falsch geschrieben, gehört zu einer Erinnerungsliste oder existiert nicht mehr. Die Fehlermeldung nennt die privaten Kalender, einen davon unter *Einstellungen → Erweiterungen → iClaude* eintragen. |
| »… is a shared calendar« | Gewollt. In geteilte Kalender schreibt der Konnektor nur, wenn du den Kalender ausdrücklich nennst, etwa »trag das in den Kalender <Name> ein«. Als Standardkalender ist ein geteilter Kalender nicht erlaubt. |
| Termin lässt sich nicht ändern oder löschen | Der Termin hat Teilnehmer, wurde von jemand anderem organisiert, liegt in einem geteilten Kalender (nur beim Löschen) oder ist ein einzelnes Vorkommen einer Serie. Die Meldung nennt den Grund. Solche Termine in Apple Kalender selbst bearbeiten. |
| Werkzeuge fehlen in Claude | Ist die Erweiterung unter *Einstellungen → Erweiterungen* eingeschaltet? Claude Desktop mit ⌘Q ganz beenden und neu starten. Hilft das nicht, in `~/Library/Logs/Claude/mcp-server-*.log` nach Statuszeilen wie Start, Verbindung und Fehler schauen. |
| Vom iPhone aus keine Werkzeuge | Der Mac schläft, ist aus oder Claude Desktop ist beendet. Siehe [Nutzung vom Handy](#nutzung-vom-handy-und-in-geplanten-aufgaben). |
| Geplante Aufgabe ist nicht gelaufen | Der Mac hat zur geplanten Zeit geschlafen. Siehe [geplante Aufgaben](#nutzung-vom-handy-und-in-geplanten-aufgaben). |
| Hinweis »nicht signiert« bei der Installation | Normal bei einer selbst gebauten Erweiterung. |

## Deinstallation

1. In Claude Desktop unter *Einstellungen → Erweiterungen* bei **iClaude** die Erweiterung deinstallieren.
2. Auf [account.apple.com](https://account.apple.com) unter *Anmeldung und Sicherheit → App-spezifische Passwörter* das Passwort für iClaude widerrufen.
3. Optional die Sicherungen löschen: den Ordner `~/Library/Application Support/icloud-mcp/`.
4. Optional die Protokolle löschen, die zu iClaude gehören: `~/Library/Logs/Claude/mcp-server-*.log`.

## Entwicklung

```bash
npm install
cp .env.example .env        # Zugangsdaten selbst eintragen, nie in einen Chat schreiben
npm run typecheck
npm test                    # ohne Netzwerk (simulierter Kalender- und IMAP-Server)
npm run build:mcpb          # baut dist/icloud-mcp-<Version>.mcpb
```

Die Entwicklerdokumentation ist auf Englisch. Aufbau, Sicherheitsregeln und bekannte Fallen: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Gemessene iCloud-Eigenheiten und Entscheidungen: [`docs/ICLOUD-NOTES.md`](docs/ICLOUD-NOTES.md).

## Lizenz und Marken

MIT-Lizenz, siehe [`LICENSE`](LICENSE). Nutzung auf eigene Verantwortung.

iClaude ist ein unabhängiges Projekt. Es steht in keiner Verbindung zu Apple oder Anthropic und wird von keinem der beiden unterstützt. iCloud ist eine Marke von Apple Inc., Claude eine Marke von Anthropic PBC.
