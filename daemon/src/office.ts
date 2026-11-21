import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const OFFICE_EXTS = ['.docx', '.xlsx', '.pptx'] as const;
export const MAX_OFFICE_FILE = 50 << 20;
const MAX_ENTRY = 100 << 20;
export const MAX_OFFICE_TEXT = 200_000;

type Zip = Map<string, () => Buffer>;

function unzip(buf: Buffer): Zip {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not an Office zip file (a password-protected file is not one)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Zip = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('not an Office file: broken zip directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    out.set(name, () => {
      if (flags & 1) throw new Error(`${name} is encrypted`);
      if (size === 0xffffffff || local === 0xffffffff) throw new Error(`${name} is a zip64 entry, which is not supported`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: broken zip entry`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
      throw new Error(`${name} uses zip method ${method}, which is not supported`);
    });
  }
  return out;
}

const xml = (zip: Zip, name: string): string | null => {
  const e = zip.get(name);
  return e ? e().toString('utf8') : null;
};

const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[k] ?? m;
});

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};

const cell = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

function rels(zip: Zip, part: string): Map<string, string> {
  const dir = posix.dirname(part);
  const body = xml(zip, posix.join(dir, '_rels', `${posix.basename(part)}.rels`)) ?? '';
  const out = new Map<string, string>();
  for (const m of body.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) out.set(id, target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(dir, target)));
  }
  return out;
}

function docx(zip: Zip): string {
  const body = xml(zip, 'word/document.xml');
  if (body === null) throw new Error('not a Word document: word/document.xml is missing');
  const lines: string[] = [];
  let para = '';
  let row: string[] = [];
  let tbl = 0;
  let inText = false;
  for (const m of body.matchAll(/<(\/?)w:(tbl|tr|tc|p|t|tab|br|cr)\b[^>]*?(\/?)>|([^<]+)/g)) {
    const [, close, tag, self, text] = m;
    if (text !== undefined) { if (inText) para += decode(text); continue; }
    if (self) { if (tag === 'tab') para += '\t'; else if (tag === 'br' || tag === 'cr') para += tbl ? ' ' : '\n'; continue; }
    if (tag === 't') { inText = !close; continue; }
    if (tag === 'tbl') { tbl += close ? -1 : 1; if (!tbl) para = ''; continue; }
    if (tbl > 1) { if (tag === 'p' && close) para += ' '; continue; }
    if (tag === 'tr' && !close) row = [];
    else if (tag === 'tr') lines.push(`| ${row.join(' | ')} |`);
    else if (tag === 'tc' && !close) para = '';
    else if (tag === 'tc') row.push(cell(para));
    else if (tag === 'p' && close && tbl) para += ' ';
    else if (tag === 'p' && close) { lines.push(para.trimEnd()); para = ''; }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(zip: Zip): boolean[] {
  const styles = xml(zip, 'xl/styles.xml') ?? '';
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '');
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    const code = custom.get(id);
    return code === undefined ? BUILTIN_DATES.has(id) : /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  });
}

const serialDate = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const d = new Date(Math.round((n - 25569) * 86400) * 1000);
  const iso = d.toISOString();
  return n % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
};

const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i: number): string => (i < 0 ? '' : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

const runText = (s: string) => [...s.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

function xlsx(zip: Zip): string {
  const book = xml(zip, 'xl/workbook.xml');
  if (book === null) throw new Error('not an Excel workbook: xl/workbook.xml is missing');
  const strings = [...(xml(zip, 'xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
  const dates = dateStyles(zip);
  const targets = rels(zip, 'xl/workbook.xml');
  const out: string[] = [];
  for (const s of book.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(s[0], 'name') ?? '';
    const part = targets.get(attr(s[0], 'r:id') ?? '');
    const sheet = part ? xml(zip, part) : null;
    out.push(`## Sheet: ${name}`, '');
    if (sheet === null) { out.push('(no worksheet data)', ''); continue; }
    const rows: { n: string; cells: Map<number, string> }[] = [];
    let width = 0;
    for (const r of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = new Map<number, string>();
      let next = 0;
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[0], 'r');
        const col = ref ? colIndex(ref) : next;
        next = col + 1;
        const inner = c[2] ?? '';
        const t = attr(`<c${c[1]}>`, 't');
        const v = /<v>([\s\S]+?)<\/v>/.exec(inner)?.[1];
        const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        let value: string;
        if (t === 'inlineStr') value = runText(inner);
        else if (v === undefined) value = f ? `=${decode(f)}` : '';
        else if (t === 's') value = strings[Number(v)] ?? '';
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (!t || t === 'n') value = dates[Number(attr(`<c${c[1]}>`, 's') ?? 0)] ? serialDate(v) : decode(v);
        else value = decode(v);
        if (value === '') continue;
        cells.set(col, cell(value));
        width = Math.max(width, col + 1);
      }
      if (cells.size) rows.push({ n: attr(`<row${r[1]}>`, 'r') ?? String(rows.length + 1), cells });
    }
    if (!rows.length) { out.push('(empty)', ''); continue; }
    const cols = Array.from({ length: width }, (_, i) => i);
    out.push(`| | ${cols.map(colName).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
    for (const r of rows) out.push(`| ${r.n} | ${cols.map((i) => r.cells.get(i) ?? '').join(' | ')} |`);
    out.push('');
  }
  return out.join('\n').trim();
}

function pptx(zip: Zip): string {
  const deck = xml(zip, 'ppt/presentation.xml');
  if (deck === null) throw new Error('not a PowerPoint deck: ppt/presentation.xml is missing');
  const targets = rels(zip, 'ppt/presentation.xml');
  const out: string[] = [];
  let n = 0;
  for (const s of deck.matchAll(/<p:sldId\b[^>]*>/g)) {
    const slide = xml(zip, targets.get(attr(s[0], 'r:id') ?? '') ?? '') ?? '';
    out.push(`## Slide ${++n}`, '');
    for (const p of slide.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
      const text = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)].map((t) => (t[1] === undefined ? '\n' : decode(t[1]))).join('').trimEnd();
      if (text) out.push(text);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

export function readOffice(path: string): { path: string; text: string; truncated: boolean } {
  if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
  const ext = extname(path).toLowerCase();
  if (!(OFFICE_EXTS as readonly string[]).includes(ext)) throw new Error(`not an Office file: the extension must be one of ${OFFICE_EXTS.join(', ')}`);
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`no such file: ${path}`);
  }
  if (!st.isFile()) throw new Error(`not a file: ${path}`);
  if (st.size > MAX_OFFICE_FILE) throw new Error(`file is over ${MAX_OFFICE_FILE >> 20} MB: ${path}`);
  const zip = unzip(readFileSync(path));
  let text = ext === '.docx' ? docx(zip) : ext === '.xlsx' ? xlsx(zip) : pptx(zip);
  const truncated = text.length > MAX_OFFICE_TEXT;
  if (truncated) text = `${text.slice(0, MAX_OFFICE_TEXT)}\n[truncated at ${MAX_OFFICE_TEXT} characters]`;
  return { path, text, truncated };
}
