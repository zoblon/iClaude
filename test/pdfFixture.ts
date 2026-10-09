/** Builds a tiny valid PDF. With text: one line of text per page (Helvetica). Without text: blank pages (like a scan without a text layer). */
export function makePdf(pages: Array<string | undefined>): Buffer {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) && objs.length;
  const font = 3;
  const kids: number[] = [];
  // 1 = catalog, 2 = pages, 3 = font, then page + content per page
  objs.push('<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const t of pages) {
    const content = t === undefined ? '' : `BT /F1 14 Tf 72 720 Td (${t.replace(/[\\()]/g, '\\$&')}) Tj ET`;
    const contentNo = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageNo = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNo} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    kids.push(pageNo);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
