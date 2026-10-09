import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapGateway, type ImapLike } from '../src/core/mail/imap.js';
import { MailService } from '../src/core/mail/service.js';
import { senderMatches } from '../src/core/mail/trash.js';
import { TrashService } from '../src/core/mail/trash.js';
import { decodeRef } from '../src/core/mail/ref.js';
import { authorizeTrash, MAX_TRASH_PER_CALL, TrashGrant } from '../src/core/permissions.js';
import { registerTrashTools, trashMessageSchema } from '../src/mcp/trashTools.js';
import { cfg } from './fakeStore.js';
import { MiniImap, rfc822, type MiniBox, type MiniMessage } from './miniImap.js';

const FROM = 'Anna Beispiel <anna@beispiel.de>';
const msg = (uid: number, flags: string[], subject: string, mid: string, from = FROM): MiniMessage => ({
  uid,
  flags,
  subject,
  from,
  messageId: `<${mid}>`,
  date: 'Wed, 07 Oct 2026 10:00:00 +0200',
  raw: rfc822({ from, subject, messageId: `<${mid}>`, date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: `Inhalt von ${subject}` }),
});

/** So sieht die Welt aus: der Papierkorb heißt hier absichtlich anders als üblich, aber trägt das Merkmal \Trash. */
const boxes = (over: Record<string, MiniBox> = {}): Record<string, MiniBox> => ({
  INBOX: { uidValidity: 1700, messages: [msg(1, [], 'Rechnung Oktober', 'a1@x'), msg(2, ['\\Seen'], 'Newsletter', 'a2@x', 'Shop <news@shop.example>'), msg(3, [], 'Wichtig', 'a3@x', 'Chef <chef@firma.de>')] },
  'Sent Messages': { special: '\\Sent', uidValidity: 1800, messages: [msg(1, ['\\Seen'], 'Gesendet', 's1@x')] },
  Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] },
  Archive: { special: '\\Archive', uidValidity: 2000, messages: [msg(1, ['\\Seen'], 'Altes', 'r1@x'), msg(2, [], 'Noch älter', 'r2@x')] },
  Verworfen: { special: '\\Trash', uidValidity: 2100, messages: [msg(1, ['\\Seen'], 'Schon im Korb', 't1@x')] },
  ...over,
});

let server: MiniImap;
let gateway: ImapGateway;
let mail: MailService;
let trash: TrashService;

async function setup(opts: { move?: boolean; advertiseMove?: boolean; boxes?: Record<string, MiniBox>; allowMoveTo?: string[] } = {}) {
  server = new MiniImap(opts.boxes ?? boxes(), { move: opts.move ?? true, ...(opts.advertiseMove !== undefined ? { advertiseMove: opts.advertiseMove } : {}) });
  for (const b of ['INBOX', 'Archive', 'Sent Messages', 'Drafts']) server.allowWriteSelect.add(b);
  for (const d of opts.allowMoveTo ?? ['Verworfen']) server.allowMove.add(d);
  await server.start();
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  mail = new MailService(cfg, gateway);
  trash = new TrashService(gateway, () => mail.mailboxes());
}

afterEach(async () => {
  await gateway?.close();
  await server?.stop();
});

const idOf = async (mailbox: string, subject: string) => {
  const r = await mail.listRecent(mailbox, 20);
  return r.messages.find((m) => m.subject === subject)!.id;
};
const item = async (mailbox: string, subject: string, from = 'anna@beispiel.de') => ({ id: await idOf(mailbox, subject), subject, from });
const subjects = (box: string) => server.boxes[box]!.messages.map((m) => m.subject).sort();
const sent = () => server.commands.map((c) => c.split(' ').slice(0, 3).join(' '));
const dangerous = () => server.commands.filter((c) => /\\Deleted|\bEXPUNGE\b|\bSTORE\b|\bCOPY\b|\bAPPEND\b|\bDELETE\b|\bCREATE\b|\bRENAME\b/i.test(c));

describe('trash_message: Verschieben in den Papierkorb (echter imapflow gegen Testserver)', () => {
  beforeEach(() => setup());

  it('verschiebt per UID MOVE in den Papierkorb, den es am Merkmal \\Trash erkennt (nicht am Namen)', async () => {
    const r = await trash.trash([await item('INBOX', 'Rechnung Oktober')]);
    expect(r.trashMailbox).toBe('Verworfen');
    expect(r.count).toBe(1);
    expect(r.moved[0]).toMatchObject({ mailbox: 'INBOX', subject: 'Rechnung Oktober' });
    expect(subjects('INBOX')).toEqual(['Newsletter', 'Wichtig']);
    expect(subjects('Verworfen')).toEqual(['Rechnung Oktober', 'Schon im Korb']);
    expect(server.moves).toEqual([{ from: 'INBOX', to: 'Verworfen', uids: [1] }]);
    expect(sent().some((c) => c.startsWith('UID MOVE'))).toBe(true);
    expect(server.violations).toEqual([]);
  });

  it('niemals \\Deleted, EXPUNGE, STORE, COPY, APPEND, DELETE oder CREATE über die Leitung', async () => {
    await trash.trash([await item('INBOX', 'Rechnung Oktober'), await item('INBOX', 'Newsletter', 'news@shop.example')]);
    await trash.trash([await item('Archive', 'Altes')]);
    expect(dangerous()).toEqual([]);
    expect(server.violations).toEqual([]);
    // Es gab nur lesende Befehle, SELECT/EXAMINE und die MOVE-Befehle.
    for (const c of server.commands) expect(c, c).toMatch(/^(CAPABILITY|LOGIN|LIST|LSUB|STATUS|SELECT|EXAMINE|CLOSE|UNSELECT|NOOP|LOGOUT|ID|UID FETCH|FETCH|UID SEARCH|SEARCH|UID MOVE|ENABLE|NAMESPACE)\b/);
  });

  it('das Ergebnis nennt, was verschoben wurde, und dass es etwa 30 Tage wiederherstellbar ist', async () => {
    const r = await trash.trash([await item('INBOX', 'Newsletter', 'Shop <news@shop.example>')]);
    expect(r.note).toMatch(/etwa 30 Tage/);
    expect(r.note).toMatch(/wiederherstellbar/);
    expect(r.moved.map((m) => m.subject)).toEqual(['Newsletter']);
  });

  it('das Tool-Ergebnis fasst es zusammen', async () => {
    const tools: Record<string, { description: string; annotations: Record<string, boolean>; handler: (a: unknown) => Promise<{ structuredContent: { zusammenfassung: string; hinweise: string[] } }> }> = {};
    registerTrashTools({ registerTool: (n: string, c: { description: string; annotations: Record<string, boolean> }, h: never) => (tools[n] = { ...c, handler: h }) } as never, trash);
    const res = await tools['trash_message']!.handler({ messages: [await item('INBOX', 'Wichtig', 'chef@firma.de')] });
    expect(res.structuredContent.zusammenfassung).toBe('1 Mail(s) in den Papierkorb verschoben.');
    expect(res.structuredContent.hinweise.join(' ')).toMatch(/30 Tage/);
  });

  it('der Posteingang wird zum Prüfen schreibgeschützt geöffnet; gelesen wird nichts markiert', async () => {
    const before = server.boxes['INBOX']!.messages.find((m) => m.subject === 'Wichtig')!.flags.slice();
    await trash.trash([await item('INBOX', 'Wichtig', 'chef@firma.de')]);
    const moved = server.boxes['Verworfen']!.messages.find((m) => m.subject === 'Wichtig')!;
    expect(moved.flags).toEqual(before); // ungelesen bleibt ungelesen
    expect(server.commands.filter((c) => /^(UID )?FETCH/.test(c)).every((c) => !/BODY\[|RFC822(?![.\w])/.test(c.replace(/BODY\.PEEK\[[^\]]*\]/g, '')))).toBe(true);
  });

  it('mehrere Mails aus mehreren Ordnern in einem Aufruf', async () => {
    const r = await trash.trash([await item('INBOX', 'Rechnung Oktober'), await item('Archive', 'Altes'), await item('INBOX', 'Wichtig', 'chef@firma.de')]);
    expect(r.count).toBe(3);
    expect(subjects('INBOX')).toEqual(['Newsletter']);
    expect(subjects('Archive')).toEqual(['Noch älter']);
    expect(subjects('Verworfen')).toEqual(['Altes', 'Rechnung Oktober', 'Schon im Korb', 'Wichtig']);
    expect(dangerous()).toEqual([]);
  });

  describe('Ablehnungen: es wird nichts verschoben', () => {
    const untouched = () => {
      expect(subjects('INBOX')).toEqual(['Newsletter', 'Rechnung Oktober', 'Wichtig']);
      expect(subjects('Verworfen')).toEqual(['Schon im Korb']);
      expect(server.moves).toEqual([]);
      expect(sent().filter((c) => c.startsWith('UID MOVE') || c.startsWith('MOVE'))).toEqual([]);
      expect(dangerous()).toEqual([]);
      expect(server.violations).toEqual([]);
    };

    it('falscher Betreff', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      await expect(trash.trash([{ ...i, subject: 'Etwas ganz anderes' }])).rejects.toThrow(/Mail 1: Der Betreff passt nicht/);
      untouched();
    });

    it('falscher Absender (Adresse, Name)', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      await expect(trash.trash([{ ...i, from: 'boese@example.com' }])).rejects.toThrow(/Mail 1: Der Absender passt nicht/);
      await expect(trash.trash([{ ...i, from: 'Max Mustermann' }])).rejects.toThrow(/Absender passt nicht/);
      await expect(trash.trash([{ ...i, from: 'Anna Beispiel <anna@falsch.example>' }])).rejects.toThrow(/Absender passt nicht/);
      untouched();
    });

    it('stimmt nur eine von mehreren Mails nicht, wird keine einzige verschoben', async () => {
      const good = await item('INBOX', 'Rechnung Oktober');
      const bad = { ...(await item('INBOX', 'Newsletter', 'news@shop.example')), subject: 'Falsch' };
      await expect(trash.trash([good, bad])).rejects.toThrow(/Mail 2: Der Betreff passt nicht/);
      untouched();
    });

    it('nennt alle Fehler auf einmal, ohne Inhalte der Mails auszugeben', async () => {
      const a = { ...(await item('INBOX', 'Rechnung Oktober')), subject: 'x', from: 'y@z.de' };
      const e = await trash.trash([a]).catch((x: Error) => x);
      expect((e as Error).message).toMatch(/Mail 1: Der Betreff passt nicht.*Mail 1: Der Absender passt nicht/s);
      expect((e as Error).message).not.toContain('Rechnung');
      expect((e as Error).message).not.toContain('anna@beispiel.de');
    });

    it('mehr als 20 Mails (Dienst), noch bevor etwas geladen wird', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      const many = Array.from({ length: MAX_TRASH_PER_CALL + 1 }, (_, n) => ({ ...i, id: i.id.replace(/\|1$/, `|${n + 100}`) }));
      server.commands.length = 0;
      await expect(trash.trash(many)).rejects.toThrow(/Zu viele Mails.*21.*höchstens 20/s);
      expect(server.commands).toEqual([]);
      untouched();
    });

    it('mehr als 20 Mails (Schema des Werkzeugs) und leere Liste', () => {
      const one = { id: 'INBOX|1700|1', subject: 's', from: 'f' };
      expect(trashMessageSchema.safeParse({ messages: Array.from({ length: 20 }, () => one) }).success).toBe(true);
      expect(trashMessageSchema.safeParse({ messages: Array.from({ length: 21 }, () => one) }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [] }).success).toBe(false);
    });

    it('die Berechtigung selbst lehnt mehr als 20 ab', () => {
      const mailboxes = [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }, { path: 'T', name: 'T', role: 'trash', roleBy: 'flag' as const }];
      expect(() => authorizeTrash({ mailboxes, sourcePaths: Array.from({ length: 21 }, () => 'INBOX') })).toThrow(/höchstens 20/);
      expect(authorizeTrash({ mailboxes, sourcePaths: Array.from({ length: 20 }, () => 'INBOX') }).count).toBe(20);
    });

    it('Pflichtangaben: Betreff und Absender fehlen oder sind leer', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      expect(trashMessageSchema.safeParse({ messages: [{ id: i.id }] }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ id: i.id, subject: 'x' }] }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ id: i.id, subject: '', from: 'x' }] }).success).toBe(false);
      await expect(trash.trash([{ ...i, subject: '  ' }])).rejects.toThrow(/Betreff/);
      await expect(trash.trash([{ ...i, from: '  ' }])).rejects.toThrow(/Absender/);
      untouched();
    });

    it('unbekannte Felder im Schema', () => {
      const ok = { id: 'INBOX|1700|1', subject: 's', from: 'f' };
      expect(trashMessageSchema.safeParse({ messages: [ok], permanent: true }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ ...ok, folder: 'Archive' }] }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ ...ok, destination: 'Archive' }] }).success).toBe(false);
    });

    it('dieselbe Mail doppelt', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      await expect(trash.trash([i, i])).rejects.toThrow(/mehrfach/);
      untouched();
    });

    it('Mails, die schon im Papierkorb liegen, werden nie angefasst', async () => {
      const inTrash = await item('Verworfen', 'Schon im Korb');
      await expect(trash.trash([inTrash])).rejects.toThrow(/bereits im Papierkorb/);
      untouched();
    });

    it('veraltete ID (UIDVALIDITY geändert)', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      await expect(trash.trash([{ ...i, id: i.id.replace('|1700|', '|999|') }])).rejects.toThrow(/veraltet/);
      untouched();
    });

    it('Mail nicht mehr vorhanden', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      await expect(trash.trash([{ ...i, id: i.id.replace(/\|1$/, '|77') }])).rejects.toThrow(/nicht gefunden/);
      untouched();
    });

    it.each(['', 'x', 'INBOX|1|', 'INBOX|a|1', '../../etc|1|1|2'])('ungültige ID "%s"', async (id) => {
      await expect(trash.trash([{ id, subject: 's', from: 'f' }])).rejects.toThrow(/Nachrichten-ID/);
      untouched();
    });

    it('unbekannter Ordner in der ID', async () => {
      await expect(trash.trash([{ id: 'GibtEsNicht|1|1', subject: 's', from: 'f' }])).rejects.toThrow(/nicht bekannt/);
      untouched();
    });

    it('das Gateway selbst lehnt gefälschte oder zu weite Freigaben ab', async () => {
      const i = await item('INBOX', 'Rechnung Oktober');
      const ref = decodeRef(i.id);
      await expect(gateway.moveToTrash({ trash: 'Verworfen', sources: new Set(['INBOX']), count: 1 } as never, [ref])).rejects.toThrow(/ohne Freigabe/);
      const grant = TrashGrant.issue('Verworfen', ['Archive'], 1); // Posteingang ist nicht freigegeben
      await expect(gateway.moveToTrash(grant, [ref])).rejects.toThrow();
      await expect(gateway.moveToTrash(TrashGrant.issue('Verworfen', ['INBOX'], 1), [ref, ref])).rejects.toThrow(); // mehr als freigegeben
      await expect(gateway.moveToTrash(TrashGrant.issue('Verworfen', ['INBOX', 'Verworfen'], 1), [{ ...ref, path: 'Verworfen' }])).rejects.toThrow();
      untouched();
    });
  });

  it('wohin verschoben wird, ist fest: ein anderer Zielordner ist im Testserver ein Verstoß', async () => {
    // Gegenprobe: Wäre der Zielordner nicht freigegeben, hätte der Testserver das MOVE als Verstoß verbucht.
    await gateway.close();
    await server.stop();
    await setup({ allowMoveTo: [] });
    await expect(trash.trash([await item('INBOX', 'Rechnung Oktober')])).rejects.toThrow();
    expect(server.violations.some((v) => v.includes('MOVE'))).toBe(true);
  });
});

describe('trash_message: Papierkorb nur über das Merkmal \\Trash', () => {
  it('ein Ordner namens "Trash" ohne Merkmal ist kein Papierkorb: es wird nichts verschoben', async () => {
    const b = boxes();
    delete b['Verworfen'];
    b['Trash'] = { uidValidity: 2100, messages: [] }; // heißt wie ein Papierkorb, trägt aber kein Merkmal
    await setup({ boxes: b, allowMoveTo: ['Trash'] });
    await expect(trash.trash([await item('INBOX', 'Rechnung Oktober')])).rejects.toThrow(/Merkmal \\Trash/);
    expect(server.moves).toEqual([]);
    expect(server.commands.filter((c) => /MOVE/.test(c))).toEqual([]);
    expect(subjects('INBOX')).toContain('Rechnung Oktober');
  });

  it('ein Ordner mit dem Merkmal wird verwendet, auch wenn ein gleichnamiger "Trash" ohne Merkmal existiert', async () => {
    const b = boxes({ Trash: { uidValidity: 2200, messages: [] } });
    await setup({ boxes: b, allowMoveTo: ['Verworfen', 'Trash'] });
    await trash.trash([await item('INBOX', 'Rechnung Oktober')]);
    expect(server.moves.map((m) => m.to)).toEqual(['Verworfen']);
    expect(subjects('Trash')).toEqual([]);
  });

  it('zwei Ordner mit dem Merkmal: nicht eindeutig, es wird nichts verschoben', async () => {
    await setup({ boxes: boxes({ Zweiter: { special: '\\Trash', uidValidity: 2300, messages: [] } }), allowMoveTo: ['Verworfen', 'Zweiter'] });
    await expect(trash.trash([await item('INBOX', 'Rechnung Oktober')])).rejects.toThrow(/nicht eindeutig/);
    expect(server.moves).toEqual([]);
  });

  it('üblicher iCloud-Name "Deleted Messages" mit Merkmal funktioniert', async () => {
    const b = boxes();
    delete b['Verworfen'];
    b['Deleted Messages'] = { special: '\\Trash', uidValidity: 2100, messages: [] };
    await setup({ boxes: b, allowMoveTo: ['Deleted Messages'] });
    const r = await trash.trash([await item('INBOX', 'Rechnung Oktober')]);
    expect(r.trashMailbox).toBe('Deleted Messages');
    expect(subjects('Deleted Messages')).toEqual(['Rechnung Oktober']);
  });
});

describe('trash_message: wie iCloud (versteht UID MOVE, nennt es aber nicht in der Fähigkeitenliste)', () => {
  beforeEach(() => setup({ move: true, advertiseMove: false }));

  it('verschiebt trotzdem, ohne je auf Löschen-Markierung, COPY oder EXPUNGE auszuweichen', async () => {
    expect(server.commands.some((c) => /^CAPABILITY/.test(c) && /\bMOVE\b/.test(c))).toBe(false);
    const r = await trash.trash([await item('INBOX', 'Rechnung Oktober'), await item('Archive', 'Altes')]);
    expect(r.count).toBe(2);
    expect(subjects('Verworfen')).toEqual(['Altes', 'Rechnung Oktober', 'Schon im Korb']);
    expect(server.commands.filter((c) => c.startsWith('UID MOVE'))).toHaveLength(2);
    expect(dangerous()).toEqual([]);
    expect(server.violations).toEqual([]);
  });
});

describe('trash_message: Server, der UID MOVE nicht versteht (kein Rückfall auf Löschen-Markierung und EXPUNGE)', () => {
  beforeEach(() => setup({ move: false }));

  it('lehnt ab, ohne etwas zu verändern oder auch nur einen verändernden Befehl zu senden', async () => {
    await expect(trash.trash([await item('INBOX', 'Rechnung Oktober')])).rejects.toThrow(/UID MOVE\) abgelehnt.*nichts verschoben und nichts gelöscht/s);
    expect(subjects('INBOX')).toEqual(['Newsletter', 'Rechnung Oktober', 'Wichtig']);
    expect(subjects('Verworfen')).toEqual(['Schon im Korb']);
    // imapflow.messageMove hätte hier selbst COPY, STORE \Deleted und EXPUNGE gesendet. Gesendet wurde nichts davon.
    expect(server.rejectedMoves).toHaveLength(1);
    expect(dangerous()).toEqual([]);
    expect(server.violations).toEqual([]);
  });

  it('auch mehrere Mails aus mehreren Ordnern: nichts passiert, und es bleibt bei einem einzigen Versuch', async () => {
    await expect(trash.trash([await item('INBOX', 'Wichtig', 'chef@firma.de'), await item('Archive', 'Altes')])).rejects.toThrow(/abgelehnt/);
    expect(dangerous()).toEqual([]);
    expect(server.rejectedMoves).toHaveLength(1); // nach der ersten Ablehnung wird nicht weiterprobiert
    expect(subjects('Archive')).toEqual(['Altes', 'Noch älter']);
    expect(subjects('INBOX')).toEqual(['Newsletter', 'Rechnung Oktober', 'Wichtig']);
  });
});

describe('Hilfsfunktionen für die Prüfung', () => {
  const from = [{ name: 'Anna Beispiel', address: 'anna@beispiel.de' }];
  it.each([
    ['anna@beispiel.de', true],
    ['ANNA@Beispiel.DE', true],
    ['Anna Beispiel <anna@beispiel.de>', true],
    ['Falscher Name <anna@beispiel.de>', true], // die Adresse entscheidet
    ['Anna Beispiel', true],
    ['  anna   beispiel ', true],
    ['anna', false],
    ['beispiel.de', false],
    ['anna@beispiel.de.evil.com', false],
    ['xanna@beispiel.de', false],
    ['Anna Beispiel <boese@example.com>', false],
    ['boese@example.com', false],
    ['', false],
  ])('Absender "%s" passt: %s', (expected, ok) => {
    expect(senderMatches(expected, from)).toBe(ok);
  });
  it('eine Mail ohne Absenderangaben lässt sich nie bestätigen', () => {
    expect(senderMatches('anna@beispiel.de', [])).toBe(false);
    expect(senderMatches('Anna', [{ address: 'anna@beispiel.de' }])).toBe(false);
  });
});

describe('Werkzeug trash_message', () => {
  it('ist als destruktiv gekennzeichnet, nicht schreibgeschützt, und beschreibt klar, was passiert und was nicht', async () => {
    await setup();
    const tools: Record<string, { description: string; annotations: Record<string, boolean> }> = {};
    registerTrashTools({ registerTool: (n: string, c: never) => (tools[n] = c) } as never, trash);
    const t = tools['trash_message']!;
    expect(t.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(t.description).toMatch(/Moves one or more emails \(max 20 per call\) into the Trash/);
    expect(t.description).toMatch(/\\Trash attribute/);
    expect(t.description).toMatch(/Does NOT delete permanently/);
    expect(t.description).toMatch(/nothing is flagged \\Deleted or expunged/);
    expect(t.description).toMatch(/30 days/);
    expect(t.description).toMatch(/id, subject and sender/);
    expect(t.description).toMatch(/moves NOTHING if any mail does not match/);
  });
});
