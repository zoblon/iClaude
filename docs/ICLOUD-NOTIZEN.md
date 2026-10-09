# iCloud-Notizen

Ergebnisse eigener Messungen gegen iCloud (Stand 8.10.2026) und Entscheidungen, die daraus folgen.
Gemessen wurde nur lesend, außer wo ausdrücklich „Testkalender" steht (für 0.2.0 siehe die Abschnitte „Löschen von Terminen" und „In den Papierkorb verschieben"; dort ist vermerkt, was nur gegen Testserver geprüft ist). Inhalte aus Terminen oder Mails sind hier nicht festgehalten.

## Kalender (CalDAV)

### Abfragen: Eigenschaften einzeln anfragen

Gemessen an einem privaten Kalender mit 32 Terminen (`calendar-query`, Zeitraum 2026–2027):

| Anfrage | Ergebnis |
|---|---|
| `calendar-data` ohne Einschränkung | 32 von 32 mit Daten, 136 KB, ca. 470 ms |
| `allprop` (statt `prop`) | **0 von 32 mit Kalenderdaten** (nur Metadaten, 23 KB) |
| `allprop` + `allcomp` innerhalb von `calendar-data` | praktisch leer (ca. 1 KB für 32 Termine) |
| VEVENT-Eigenschaften einzeln (`comp`/`prop`) | 32 von 32 mit Daten, **37 KB (−73 %)**, ca. 370 ms |

Entscheidung: Lesende Abfragen (`list_events`, `search_events`, `find_free_slots`) fragen genau die Eigenschaften an, die sie
brauchen (`UID, SUMMARY, DTSTART, DTEND, DURATION, RRULE, RDATE, EXDATE, RECURRENCE-ID, LOCATION, DESCRIPTION, STATUS, TRANSP,
ORGANIZER, ATTENDEE, SEQUENCE`, dazu `ACTION`/`TRIGGER` der Erinnerungen). Das steht in `src/core/calendar/caldav.ts` (`EVENT_PROPS`).

**Folge:** Eine so abgefragte Kopie ist unvollständig. Sie wird **nie zum Schreiben verwendet**. `update_event` lädt den Termin immer
vollständig per GET (`getObject`), prüft darauf Rechte und ETag und ändert genau diese Datei.

### Zeitzonendefinitionen fehlen in eingeschränkten Antworten

iCloud liefert bei eingeschränkten Abfragen die `VTIMEZONE`-Komponente nicht mit (drei Varianten probiert: `comp` mit `prop TZID`,
leerer `comp`, `allprop`/`allcomp`). Für gängige Namen (IANA, z. B. `Europe/Berlin`) ist das unkritisch, weil die Zeiten über
den Namen aufgelöst werden. Taucht ein unbekannter Zeitzonenname auf (z. B. Windows-Namen wie „W. Europe Standard Time" aus
Outlook-Einladungen), wird genau dieser Termin vollständig per GET nachgeladen (`hasUnknownTzid`).

### Einzelner Termin per GET

`GET <Kalender>/<Datei>.ics` funktioniert, liefert den vollständigen Termin (`text/calendar`) und den ETag im Header `ETag`.
Der ETag ist identisch mit dem aus der Abfrage und kommt mit Anführungszeichen (`"muznm0s0"`).
Manche Clients verlieren die Anführungszeichen; ETags werden deshalb ohne `W/` und ohne Anführungszeichen verglichen.
Der Server prüft beim Schreiben trotzdem den echten ETag (`If-Match`).

### Schreiben

- `tsdav` wirft bei abgelehntem Schreiben **keinen** Fehler, sondern gibt die `Response` zurück. Der Status wird selbst geprüft
  (412 = Termin inzwischen geändert, 403 = keine Rechte, 404 = nicht gefunden).
- Anlegen sendet `If-None-Match: *` (nie überschreiben), Ändern sendet `If-Match: <ETag>`.
- iCloud ersetzt beim Speichern die mitgesendete `VTIMEZONE` durch seine eigene, vollständige Definition. Das ist unkritisch.
- Gespeicherte Dateien enthielten nach unseren Schreibtests weder `ATTENDEE`, `ORGANIZER` noch `METHOD`; Erinnerungen blieben erhalten.
- Änderungen erhöhen `SEQUENCE` um eins und setzen `LAST-MODIFIED` neu, damit Apple-Geräte die Änderung übernehmen.

### Geteilte Kalender erkennen

Eigenschaften je Kalender (PROPFIND auf die Kalender-Sammlung):

- Kalender, die ich **selbst teile**: `resourcetype` enthält `sharedOwner`, und `cs:invite` ist vorhanden. Eigentümer ist der eigene Account.
- Privat: nur `calendar`, kein `invite`, Eigentümer ist der eigene Account.
- Mit mir geteilte Kalender anderer Personen (`shared` im `resourcetype` bzw. anderer Eigentümer) kamen im Testkonto nicht vor.
  Der Code behandelt sie als geteilt, ist hier aber nicht live geprüft.

Regel im Code (`classifyCalendar`): **Im Zweifel gilt ein Kalender als geteilt.** Privat ist nur, was eindeutig dem eigenen Account gehört
und keine Freigabe-Merkmale trägt.

### Sonstiges

- Erinnerungslisten erscheinen als Kalender mit `VTODO`; sie werden nicht unterstützt.
- Der Inspector-CLI liest `--tool-arg`-Werte als JSON. Ein Wert wie `"abc"` (mit Anführungszeichen) kommt ohne Anführungszeichen an.

## Kontakte (CardDAV)

- Ein Adressbuch, Anzeigename leer, ID eines Kontakts ist der Pfad der Datei (`…/carddavhome/card/<UUID>.vcf`).
- Apple verknüpft Bezeichnungen über Gruppenpräfixe (`item1.EMAIL` + `item1.X-ABLabel:_$!<Work>!$_`); das wird zu „Work" aufgelöst.
- Geburtstage ohne Jahr stehen mit Jahr 1604 oder 1900; sie werden als `--MM-TT` ausgegeben. Fotos werden nie übernommen.
- Schreibende CardDAV-Funktionen werden nicht verwendet; ein Test stellt das sicher. Kontakte werden auch in 0.2.0 nicht gelöscht.

## Mail (IMAP), Ergebnis des Machbarkeitstests

- `imap.mail.me.com:993`, Login mit der @icloud.com-Adresse.
- Die Fähigkeitenliste nennt weder `SPECIAL-USE` noch `THREAD=…` noch `MOVE`, wohl aber `UIDPLUS` (Messung nach der Anmeldung am 8.10.2026, siehe „In den Papierkorb verschieben").
  **Korrektur (8.10.2026, live gemessen):** Nur „Sent Messages" (`\Sent`) und „Deleted Messages" (`\Trash`) tragen ein Spezialordner-Merkmal in der LIST-Antwort; „Drafts", „Archive" und „Junk" tragen keines, INBOX nur `\Noinferiors`.
  Die Rollen von Entwürfe, Archiv und Spam erkennt `imapflow` deshalb am **Namen** (englische Standardnamen); nur der Papierkorb wird in 0.2.0 am Merkmal erkannt.
- Ordner: INBOX, Sent Messages, Drafts, Archive, Junk, Deleted Messages. Das Archiv ist groß (rund 6000 Mails): Volltextsuche dort braucht Zeitlimits und Obergrenzen.
- Konversationen (`get_thread`) müssen über die Kopfzeilen `Message-ID`, `In-Reply-To`, `References` selbst gebildet werden, weil `THREAD` fehlt.

### Vorgaben für das Lesen von Mail (umgesetzt und getestet)

1. Postfächer werden zum Lesen **schreibgeschützt** geöffnet (`EXAMINE`), Inhalte nur mit `BODY.PEEK` geholt. Die IMAP-Schnittstelle im Code (`ImapLike`) enthält
   gar keine Methode, die Flags setzt, löscht, verschiebt, kopiert oder anhängt.
2. Test (`test/mailWire.test.ts`): Das echte `imapflow` spricht mit einem Testserver, der jeden Befehl protokolliert und sich wie ein echter Server verhält
   (beschreibbar geöffnet + Abruf ohne PEEK würde die Nachricht als gelesen markieren). Nach allen Lesewerkzeugen sind die Flags identisch, es gab nur `EXAMINE`
   und nur `BODY.PEEK`, und es wurde nie `STORE`, `COPY`, `MOVE`, `APPEND`, `EXPUNGE`, `DELETE`, `CREATE` o. Ä. gesendet. Eine Gegenprobe zeigt, dass der Testserver Verstöße erkennt.
3. `get_message` liefert lange Texte seitenweise (8000 Zeichen, gezählt in Unicode-Zeichen) mit `page.offset`, `page.nextOffset`, `page.totalLength`.
   Ein Offset hinter dem Ende wird auf das Ende begrenzt.

Weitere Entscheidungen:

- HTML-Mails: Versteckte Elemente (`display:none`, `visibility:hidden`, `font-size:0`, `opacity:0`, Höhe/Breite 0, `hidden`), Skripte, Stile und Bildadressen
  werden nicht übernommen. Das ist ein bekannter Weg, unsichtbare Anweisungen in Mails zu verstecken.
- Die Serversuche von iCloud findet Wörter in MIME-kodierten Kopfzeilen (Betreff mit Umlauten oder Sonderzeichen) nicht, auch nicht mit `TEXT`.
  Live gemessen: Bei einer Mail mit Nicht-ASCII-Betreff fand `TEXT` 2 von 6 Betreff-Wörtern nicht. Bei Suche nach Absender, Empfänger, Betreff **und Volltext**
  werden deshalb zusätzlich die neuesten 300 Nachrichten des Ordners mit decodierten Kopfzeilen lokal geprüft (nur wenn die Serversuche weniger Treffer als das Limit lieferte).
  Im Nachrichtentext selbst findet nur der Server.

### Konversationen: Kopfzeilen-Suche braucht spitze Klammern

Gemessen im Entwürfe-Ordner: `SEARCH HEADER Message-ID <wert>` findet nur, wenn der Wert **mit** den spitzen Klammern gesucht wird (`<abc@icloud.com>`).
Ohne Klammern (oder nur die UUID) liefert iCloud **stillschweigend 0 Treffer**, andere Server vergleichen als Teilstring. Mit Klammern funktionieren
`Message-ID`, `In-Reply-To`, `References` und die Kombination mit `OR`. Die Groß-/Kleinschreibung der Message-ID muss stimmen.
`get_thread` sucht deshalb mit `<id>`. Der Testserver (`test/miniImap.ts`) bildet dieses Verhalten nach, ein Test schlägt ohne Klammern fehl.
`SEARCH TEXT <uuid>` findet die Nachricht ebenfalls, wäre aber als Rückfall zu ungenau.

### Entwürfe (IMAP APPEND)

- Der Entwurf wird per `APPEND` in den Ordner mit `\Drafts` gelegt (hier „Drafts"), mit den Flags `\Seen` und `\Draft`, wie Apple Mail es bei eigenen Entwürfen tut.
  Ohne `\Seen` würde jeder Entwurf als ungelesene Mail gezählt.
- iCloud unterstützt `UIDPLUS`: Die Antwort enthält `APPENDUID`, daraus wird die ID des Entwurfs gebildet (für `get_message`, `reply_to_id`).
- Die Nachricht ist eine einfache UTF-8-Textmail (Base64). Betreff und Namen werden nach RFC 2047 kodiert. Es gibt weder Bcc noch Anhänge.
- Live gemessen (Testentwürfe an die eigene Adresse): Text, Betreff mit Umlauten und Emoji, Absender, Empfänger und die Verknüpfung einer Antwort
  (`In-Reply-To`, `References`) kommen unverändert aus iCloud zurück. Entwürfe zählen nicht als ungelesen.
- Ein Verbindungsabbruch während des `APPEND` wird **nicht** wiederholt, damit nie zwei Entwürfe entstehen.

## Löschen von Terminen (0.2.0)

Entscheidungen (umgesetzt und gegen Testserver getestet, `test/delete.test.ts`):

- `delete_event` lädt den Termin per GET, prüft Rechte (`authorizeDelete`), vergleicht Titel und Startzeit mit den Angaben und legt dann die Sicherung an. Erst danach folgt
  `DELETE <Termin>.ics` mit `If-Match: <ETag aus dem GET>`. Schlägt die Sicherung fehl, wird nicht gelöscht; schlägt das Löschen fehl, wird die gerade angelegte Sicherung wieder entfernt.
- Abgelehnt: geteilte Kalender (immer, `shared_calendar` zählt nicht), Teilnehmer, fremder Organisator, einzelne Vorkommen (`occurrence_start`), Einträge ohne Haupttermin, schreibgeschützte/abonnierte Kalender.
- Das `DELETE` wird mit `fetch` gesendet (wie das GET), nicht mit `tsdav`: so ist `If-Match` sichtbar und per HTTP-Test belegt; Zugangsdaten gehen nur an den Kalender-Server und nur für Ressourcen des freigegebenen Kalenders.
- **iCloud kann einzelne gelöschte Termine nicht wiederherstellen** (es gibt nur Sicherungen des ganzen Kontos). Deshalb: Ergebnis mit vollständigem Termin für `create_event` und `.ics`-Sicherung.
- Sicherung: `~/Library/Application Support/icloud-mcp/deleted/JJJJ-MM-TT_HHMMSS_Titel.ics`, Ordner 0700, Dateien 0600, nach dem Schreiben zur Kontrolle zurückgelesen. Aufräumen bei jedem Löschen:
  älter als 90 Tage (Änderungszeit der Datei) oder jenseits der 200 neuesten; nur Dateien nach dem eigenen Namensmuster.
- **Live gemessen am 8.10.2026** (mit einem eigenen Testtermin in einem Testkalender): Anlegen, dann Löschversuche mit falschem Titel, falscher Startzeit und veraltetem ETag (alle abgelehnt, Termin blieb), dann das echte Löschen.
  iCloud akzeptierte `DELETE` mit `If-Match` auf den ETag aus dem GET (2xx); der Termin war danach weg, ein zweites Löschen meldete „nicht gefunden". Die Sicherung (3 KB, Rechte 600, Ordner 700) enthielt `VEVENT`, Titel und beide `VALARM`.
  Aus dem Ergebnis ließ sich der Termin mit `create_event` neu anlegen (Titel, Start, Ende, Ort und Notiz identisch) und wieder löschen.
- Noch offen: die Wiederherstellung der `.ics` per Doppelklick in Apple Kalender, und das Verhalten von `DELETE` mit veraltetem ETag auf Serverseite (HTTP 412 ist nur gegen einen lokalen Testserver belegt; die ETag-Prüfung vor dem Löschen fängt es live schon ab).

## In den Papierkorb verschieben (0.2.0)

Entscheidungen (umgesetzt, gegen Testserver mit dem echten `imapflow` getestet, `test/trash.test.ts`; `UID MOVE` selbst live belegt, der vollständige Weg über `trash_message` gegen iCloud siehe Übergabe):

- Verschoben wird nur mit `UID MOVE` aus einem beschreibbar geöffneten Ordner (`SELECT`), direkt gesendet (`exec`), nicht über `imapflow.messageMove`. Die Prüfung vor dem Verschieben (Betreff, Absender) läuft schreibgeschützt (`EXAMINE`, nur Kopfzeilen und Flags).
- **Fund:** `imapflow.messageMove` weicht bei fehlender `MOVE`-Fähigkeit stillschweigend auf `COPY`, `\Deleted` setzen und `EXPUNGE` aus. Das ist verboten, und iCloud bietet `MOVE` nicht an (s. u.). Deshalb wird `messageMove` nirgends verwendet;
  `moveToTrash` sendet `UID MOVE` direkt. Lehnt der Server ab, bricht der Aufruf mit klarer Meldung ab. Tests: Server, der `MOVE` versteht und nennt; Server, der es versteht, aber nicht nennt (wie iCloud); Server, der es nicht versteht.
  In allen Fällen wird nie `COPY`, `STORE`, `\Deleted` oder `EXPUNGE` gesendet. Gegenprobe: Mit eingebautem `messageMove` schlagen vier Netzwerktests und der Quelltext-Wächter an.
- **Fund:** `imapflow` bestimmt Spezialordner nach dem Namen, wenn der Server `SPECIAL-USE` nicht anbietet (iCloud nennt es nicht). Der Papierkorb wird deshalb direkt am Merkmal `\Trash` der LIST-Antwort erkannt
  (`MailboxInfo.roleBy === 'flag'`). Ein Ordner namens „Trash" ohne Merkmal gilt nicht; mehrere Ordner mit Merkmal gelten als nicht eindeutig.
- Mails im Papierkorb werden nie angefasst, höchstens 20 Mails je Aufruf, alles oder nichts: passt bei einer Mail Betreff oder Absender nicht, wird keine verschoben. Fehlermeldungen geben keine Mail-Inhalte wieder.
- Betreff-Vergleich ohne Beachtung von Groß-/Kleinschreibung und Leerraum, auch in der auf 300 Zeichen gekürzten Form. Absender: enthält die Angabe eine Adresse, muss genau diese Adresse stimmen, sonst der Anzeigename.
- **MOVE-Fähigkeit von iCloud (live gemessen am 8.10.2026 mit `npm run imap-capabilities`, nur CAPABILITY und LIST): NEIN.** Nach der Anmeldung nennt iCloud 21 Fähigkeiten:
  `CONDSTORE CONTEXT=SORT ENABLE ESEARCH ESORT ID IDLE IMAP4 IMAP4rev1 LIST-STATUS NAMESPACE QRESYNC QUOTA SASL-IR SORT UIDPLUS UNSELECT WITHIN X-APPLE-REMOTE-LINKS XAPPLELITERAL XAPPLEPUSHSERVICE`.
  Weder `MOVE` noch `SPECIAL-USE` noch `XLIST`. Der Papierkorb „Deleted Messages" trägt aber das Merkmal `\Trash` und wird damit gefunden.
  **Aber:** iCloud **versteht `UID MOVE` trotzdem** (live belegt am 8.10.2026): Ein Test-Entwurf wurde aus „Drafts" per `UID MOVE <uid> "Deleted Messages"` verschoben (Antwort `OK`, „completed", rund 190 ms; Entwürfe 1 → 0, Papierkorb 8 → 9;
  gesendet wurde nur dieser eine Befehl, kein `COPY`, `STORE`, `\Deleted` oder `EXPUNGE`). Die Fähigkeitenliste ist hier also kein verlässlicher Hinweis; `trash_message` fragt sie deshalb nicht ab, sondern versucht `UID MOVE` und bricht bei Ablehnung ab.
- **Vollständiger Weg live getestet am 8.10.2026** (`TrashService` und `ImapGateway` gegen iCloud, mit einem Test-Entwurf an die eigene Adresse, nicht gesendet): Papierkorb „Deleted Messages" wurde am Merkmal `\Trash` erkannt.
  Falscher Betreff und falscher Absender wurden abgelehnt (Entwurf blieb im Ordner Entwürfe, Zähler unverändert). Das echte Verschieben klappte (Entwürfe 1 → 0, Papierkorb 11 → 12), die Mail war danach im Papierkorb auffindbar und blieb „gelesen"
  (der Entwurf trägt `\Seen`; das Prüfen der Kopfzeilen markiert nichts). Ein erneuter Versuch mit der Mail im Papierkorb wurde abgelehnt, 21 Mails ebenfalls (ohne Netzwerkzugriff).
- Wiederherstellbarkeit „etwa 30 Tage" im Papierkorb ist die Angabe aus dem Auftrag; sie ist nicht gemessen.

## Claude Desktop: Freigabe pro Werkzeug, Installation über eine bestehende Version (recherchiert 8.10.2026)

- Die Hilfeartikel von Anthropic beschreiben Freigabestufen für Konnektor-Werkzeuge („Always allow", „Needs approval", „Blocked") im Zusammenhang mit Cowork (Auswahl über das Plus-Menü bzw. *Anpassen → Konnektoren*).
  Ob und wo genau lokale Erweiterungen diese Stufen unter *Einstellungen → Erweiterungen* zeigen, steht dort nicht; die Oberfläche ist im README so beschrieben, wie der Auftrag sie nennt, und beim Update zu prüfen.
- **Geplante Aufgaben und „Nachfragen":** Eine ausdrückliche Aussage fehlt. Ein Fehlerbericht ([anthropics/claude-code Issue 60443](https://claudeissues.com/issue/60443-bug-create-scheduled-task-blocked-by-permissionmode-gate-in-1-7196-0-mcp-unusabl))
  zeigt, dass Werkzeuge mit Rückfrage in unbeaufsichtigten Läufen als „unavailable in unsupervised mode" abgewiesen werden. Das README formuliert es deshalb als Folge der Freigabe pro Werkzeug, nicht als zugesicherte Eigenschaft.
- **Neue `.mcpb` über eine bestehende Version installieren:** Weder der Hilfeartikel „Getting started with Local MCP servers on Claude Desktop" noch der Anthropic-Engineering-Beitrag zu Desktop Extensions noch das README des mcpb-Repositorys sagen, ob die Erweiterung ersetzt wird
  und ob die Einstellungen erhalten bleiben. Dokumentiert: Verzeichnis-Erweiterungen aktualisieren sich automatisch, private Erweiterungen werden mit neuen `.mcpb`-Dateien von Hand installiert.
- **Beobachtung auf einem Mac mit installierter Erweiterung** (nur Namen und Aufbau angesehen, keine Werte): Die Erweiterung ist als `local.mcpb.<autor>.icloud-connector` registriert (Kennung aus Autor und Name; beides bleibt in 0.2.0 gleich).
  Programmdateien liegen in `Claude Extensions/<Kennung>/`, die Installationsangaben in `extensions-installations.json` (Version, Prüfsumme, Manifest), die Einstellungen (`isEnabled`, `userConfig`) in `Claude Extensions Settings/<Kennung>.json`.
  Die Einstellungen sind also von den Programmdateien getrennt und an die Kennung gebunden. **Ob der Installer sie beim Überinstallieren behält, ist nicht belegt**; das README sagt das so und rät, das Passwort bereitzuhalten.

## Claude Desktop: Elicitation (Rückfrage vor dem Schreiben)

Geprüft wurde, ob Claude Desktop MCP-Elicitation unterstützt, um Schreibzugriffe in geteilten Kalendern vorher per Rückfrage bestätigen zu lassen.

- Die offizielle MCP-Clientübersicht führt Elicitation **nur für Claude Code** (seit Version 2.1.76). Für Claude Desktop ist dort **Roots** eingetragen, nicht Elicitation ([Änderung im MCP-Repository, am 14.3.2026 übernommen](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2398)).
- Ein Fehlerbericht zeigt, dass Claude Desktop (Cowork) `elicitation/create` ohne Anzeige sofort mit `cancel` beantwortet, während derselbe Server in Claude Code funktioniert ([anthropics/claude-code#56243](https://github.com/anthropics/claude-code/issues/56243), als Duplikat der offenen Feature-Anfrage #2799 geschlossen).

**Entscheidung:** Claude Desktop unterstützt Elicitation (Stand 8.10.2026) nicht verlässlich. Es bleibt bei der bisherigen Regel:
In einen geteilten Kalender wird nur geschrieben, wenn er ausdrücklich mit `shared_calendar="<Name>"` genannt wird; sonst wird abgelehnt.
Elicitation wird deshalb nicht eingebaut. Sollte sich das ändern, wäre eine zusätzliche Rückfrage eine Ergänzung, die diese Regel nicht ersetzt.

## Verpackung als Desktop Extension (.mcpb)

- Manifest-Version 0.3 (wie die bereits installierten Erweiterungen auf diesem Mac). Das Werkzeug `mcpb` (2.1.2) kennt 0.1 bis 0.4.
- Claude Desktop startet Node-Erweiterungen mit seinem **eingebauten Node** („Using built-in Node.js for MCP server" im Log), derzeit Electron 44.
  Es muss nichts installiert sein. Der Code verlangt Node >= 20 (Vorgabe von `imapflow`) und ist mit Node 25.9 getestet.
- `npm run build:mcpb` bündelt den Server mit esbuild zu **einer** Datei (`server/index.mjs`, rund 5 MB entpackt, 1,1 MB gepackt), legt Manifest und Symbol daneben,
  prüft mit `mcpb validate`, packt mit `mcpb pack` und prüft das Paket (nur erwartete Dateien, keine `.env`, keine Zugangsdaten aus `.env` im Paket).
- Sensible Einstellungen (`sensitive: true`) speichert Claude Desktop laut [Anthropic](https://www.anthropic.com/engineering/desktop-extensions) im macOS-Schlüsselbund und reicht sie als Umgebungsvariable weiter.
  Nicht ausgefüllte optionale Felder kommen u. U. als unersetzter Platzhalter (`${user_config.…}`) an; `loadConfig` behandelt das als leer.
- **Nicht tun:** Die Claude-App selbst im Node-Modus aufrufen (`ELECTRON_RUN_AS_NODE=1 …/Claude -e …`). Der Modus ist gesperrt; der Aufruf startet stattdessen eine
  **zweite App-Instanz**. Das ist beim Testen passiert und wurde sofort beendet. Zum Testen reicht das normale Node (`scripts/dev-bundle.sh`).
- Hinweis zum Datenschutz: Claude Desktop protokolliert die MCP-Nachrichten in `~/Library/Logs/Claude/mcp-server-*.log`, **auch die Ergebnisse** (Termine, Mailtexte).
  Der Konnektor selbst schreibt keine Inhalte ins Protokoll, die App aber schon.

## Geplante Aufgaben und Handy (geklärt 9.10.2026, im README)

- **Handy, praktisch geprüft am 8.10.2026:** Aus der Claude-App auf dem iPhone, in einer mit dem Mac verbundenen Unterhaltung, funktionierten `list_calendars`, `unread_counts`, `list_events` und `create_event`, auch mit `shared_calendar` und für viele Termine hintereinander. Bedingung: Mac wach, Claude Desktop geöffnet.
- **Geplante Aufgaben:** Die [Anthropic-Dokumentation zu lokalen geplanten Aufgaben in Claude Desktop](https://code.claude.com/docs/en/desktop-scheduled-tasks) (abgerufen 9.10.2026) sagt ausdrücklich: Läufe finden nur statt, wenn die App läuft und der Rechner wach ist; ein verschlafener Termin wird übersprungen, beim Aufwachen gibt es höchstens einen Nachholdurchlauf für die letzten sieben Tage; *Keep computer awake* (Einstellungen → Desktop app → General) verhindert den Ruhezustand bei Untätigkeit, ein zugeklappter Deckel nicht; ein Lauf, der eine Freigabe braucht, bleibt stehen, bis jemand antwortet. Der frühere Widerspruch zwischen Hilfeartikeln betraf Aufgaben, die keine lokalen Werkzeuge brauchen; für diesen lokalen Konnektor gilt die obige Aussage.
- **Nicht getestet:** eine geplante Aufgabe mit diesem Konnektor. Das README sagt das so.

## Praxistest „Lesen ändert nichts" an iCloud (8.10.2026)

Mit einer absichtlich ungelesenen Mail im Posteingang: `get_message` (Text und Markdown), `get_thread` und `search_messages` gelesen;
danach waren die Flags von 56 Nachrichten (Posteingang, Gesendet, Entwürfe, Archiv, Papierkorb, Spam) identisch, die Mail weiterhin ungelesen,
und der Server meldete weiterhin 1 ungelesene Nachricht.
