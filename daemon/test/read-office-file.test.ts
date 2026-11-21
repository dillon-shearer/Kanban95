import './home.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { mint } from '../src/grants.ts';
import { readOffice } from '../src/office.ts';
import { start } from '../src/server.ts';
import { initTemplates, render } from '../src/templates.ts';

function zip(files: Record<string, string>, stored = false): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = stored ? raw : deflateRawSync(raw);
    const n = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(stored ? 0 : 8, 8);
    h.writeUInt32LE(crc32(raw), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(stored ? 0 : 8, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(h, n, data);
    central.push(c, n);
    offset += h.length + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Object.keys(files).length, 8);
  e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(dir.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, e]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const DOCX = {
  'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run('Invoice ')}${run('#42')}</w:p>` +
    `<w:p>${run('Bill to: Smith &amp; Sons')}</w:p>` +
    '<w:tbl><w:tblPr/><w:tr><w:tc><w:p>' + run('Item') + '</w:p></w:tc><w:tc><w:p>' + run('Price') + '</w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p>' + run('Widget') + '</w:p><w:p>' + run('blue') + '</w:p></w:tc><w:tc><w:p>' + run('12.50') + '</w:p></w:tc></w:tr></w:tbl>' +
    `<w:p>${run('Total')}<w:r><w:tab/></w:r>${run('12.50')}</w:p>` +
    '</w:body></w:document>',
};
const XLSX = {
  'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Lines" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; terms" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><t>Qty</t></si><si><r><t>Wid</t></r><r><t>get</t></r></si><si><t>Pay in 30 days</t></si></sst>',
  'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Date</t></is></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c><c r="C2"><f>B2*4</f><v></v></c><c r="D2" s="1"><v>46346</v></c></row>' +
    '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="5"><c r="B5" t="s"><v>3</v></c></row></sheetData></worksheet>',
};
const PPTX = {
  'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:pPr/><a:r><a:t>First </a:t></a:r><a:r><a:t>slide</a:t></a:r></a:p></p:sld>',
};

let dir: string;
let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let planner: Client;
const put = (name: string, data: Buffer | string) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'k95-office-'));
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  initTemplates(repo);
  const p = mint(srv.db, { ticket: null, role: 'planner', ttlMs: 60_000 });
  planner = new Client({ name: 'test', version: '0' });
  await planner.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${p.token}` } } }));
});
afterAll(async () => {
  await planner.close();
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('read_office_file', () => {
  it('a planner gets a .docx paragraphs and table rows, and the file is left byte for byte as it was', async () => {
    const path = put('Invoice.DOCX', zip(DOCX));
    const before = { hash: createHash('sha256').update(readFileSync(path)).digest('hex'), mtime: statSync(path).mtimeMs };
    const r = (await planner.callTool({ name: 'read_office_file', arguments: { path } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError, r.content[0].text).toBeFalsy();
    const out = JSON.parse(r.content[0].text);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe('Invoice #42\nBill to: Smith & Sons\n| Item | Price |\n| Widget blue | 12.50 |\nTotal\t12.50');
    expect({ hash: createHash('sha256').update(readFileSync(path)).digest('hex'), mtime: statSync(path).mtimeMs }).toEqual(before);
  });

  it('a .xlsx gives sheet names and cell values: shared, inline, rich, dates, and a formula with no saved value', () => {
    const { text } = readOffice(put('book.xlsx', zip(XLSX)));
    expect(text).toBe([
      '## Sheet: Lines',
      '',
      '| | A | B | C | D |',
      '|---|---|---|---|---|',
      '| 1 | Item | Qty |  | Date |',
      '| 2 | Widget | 3 | =B2*4 | 2026-11-20 |',
      '',
      '## Sheet: Notes & terms',
      '',
      '| | A | B |',
      '|---|---|---|',
      '| 5 |  | Pay in 30 days |',
    ].join('\n'));
  });

  it('a .pptx gives slides in deck order, and stored (uncompressed) entries read too', () => {
    expect(readOffice(put('deck.pptx', zip(PPTX, true))).text).toBe('## Slide 1\n\nFirst slide\n\n## Slide 2\n\nSecond');
  });

  it('refuses a relative path, another extension, a folder, a missing file and a file that is not a zip', async () => {
    const env = put('.env', 'SECRET=x');
    mkdirSync(join(dir, 'folder.docx'));
    const fake = put('fake.xlsx', 'PK not really');
    const call = async (path: string) => {
      const r = (await planner.callTool({ name: 'read_office_file', arguments: { path } })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).not.toContain('SECRET');
      return r.content[0].text;
    };
    expect(await call('Invoice.docx')).toMatch(/must be absolute/);
    expect(await call(env)).toMatch(/extension must be one of/);
    expect(await call(join(dir, 'notes.txt'))).toMatch(/extension must be one of/);
    expect(await call(join(dir, 'folder.docx'))).toMatch(/not a file/);
    expect(await call(join(dir, 'gone.docx'))).toMatch(/no such file/);
    expect(await call(fake)).toMatch(/not an Office zip file/);
    expect(await call(put('empty.docx', zip({ 'other.xml': '<x/>' })))).toMatch(/word\/document\.xml is missing/);
  });

  it('the planner prompt says how to read an Office file and lists the tool', () => {
    const text = render(repo, 'brainstorm', buildContext(srv.db, repo, null, 'planner'));
    expect(text).toMatch(/Office file[^\n]*`read_office_file`[^\n]*absolute path/);
    expect(text).toContain('- read_office_file (yes)');
  });
});
