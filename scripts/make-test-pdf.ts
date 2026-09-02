/**
 * Builds a small but genuinely valid PDF in memory, with a correct cross-
 * reference table, so upload validation and the pdf.js reader can be exercised
 * end to end without checking a binary fixture into the repository.
 */
export function makeTestPdf(title = 'Cookie Notes test note', lines = 40): Buffer {
  const objects: string[] = [];

  const content = [
    'BT',
    '/F1 20 Tf',
    '50 790 Td',
    `(${escapePdf(title)}) Tj`,
    '/F1 11 Tf',
    ...Array.from({ length: lines }, (_, index) => [
      '0 -17 Td',
      `(${escapePdf(`Line ${index + 1} — generated for automated verification.`)}) Tj`,
    ]).flat(),
    'ET',
  ].join('\n');

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
    '/Resources << /Font << /F1 5 0 R >> >> >>';
  objects[4] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [0];

  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

function escapePdf(value: string): string {
  return value.replace(/[\\()]/g, (match) => `\\${match}`).replace(/[^\x20-\x7e]/g, '-');
}
