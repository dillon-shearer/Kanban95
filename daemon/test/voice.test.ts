import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { download, modelDir, status, voiceFile, type Manifest } from '../src/voice.ts';

// A local stand-in for the model host: serves fixed bytes per path and counts requests.
const FILES: Record<string, Buffer> = { 'config.json': Buffer.from('{"a":1}'), 'onnx/model.onnx': Buffer.alloc(4096, 7) };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let server: Server;
let source: string;
let hits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    const path = req.url!.replace(/^\/resolve\/[^/]+\//, '');
    const body = FILES[path];
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  source = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const manifest = (id: string, files: Manifest['files']): Manifest => ({ id: `test/${id}`, source, revision: 'abc', license: 'test', files });
const good = (path: string) => ({ path, size: FILES[path].length, sha256: sha(FILES[path]) });

describe('voice model download', () => {
  it('reports the model as missing without touching the network', () => {
    const m = manifest('idle', [good('config.json')]);
    const before = hits;
    expect(status(m)).toMatchObject({ downloaded: false, received: null, size: FILES['config.json'].length });
    expect(hits).toBe(before);
  });

  it('downloads and keeps files whose size and SHA-256 match the manifest', async () => {
    const m = manifest('good', [good('config.json'), good('onnx/model.onnx')]);
    await download(m);
    expect(readFileSync(join(modelDir(m), 'onnx', 'model.onnx'))).toEqual(FILES['onnx/model.onnx']);
    expect(status(m).downloaded).toBe(true);
  });

  it('rejects a file with the wrong hash and deletes it, naming the file and both hashes', async () => {
    const wrong = { ...good('onnx/model.onnx'), sha256: '0'.repeat(64) };
    const m = manifest('badhash', [good('config.json'), wrong]);
    await expect(download(m)).rejects.toThrow(`onnx/model.onnx: expected sha256 ${'0'.repeat(64)} (4096 bytes), got ${sha(FILES['onnx/model.onnx'])}`);
    const file = join(modelDir(m), 'onnx', 'model.onnx');
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.part`)).toBe(false);
    expect(status(m).downloaded).toBe(false);
  });

  it('stops reading a response larger than the pinned size', async () => {
    const m = manifest('big', [{ ...good('onnx/model.onnx'), size: 100 }]);
    await expect(download(m)).rejects.toThrow('onnx/model.onnx: larger than the pinned 100 bytes');
    expect(existsSync(join(modelDir(m), 'onnx', 'model.onnx.part'))).toBe(false);
  });

  it('replaces a file on disk whose hash no longer matches', async () => {
    const m = manifest('tampered', [good('config.json')]);
    const file = join(modelDir(m), 'config.json');
    mkdirSync(modelDir(m), { recursive: true });
    writeFileSync(file, '{"a":2}'); // same size, different bytes
    await download(m);
    expect(readFileSync(file)).toEqual(FILES['config.json']);
  });

  it('serves only paths the manifest lists', () => {
    const m = manifest('serve', [good('config.json')]);
    expect(voiceFile('/voice-model/test/serve/config.json', m)).toBe(join(modelDir(m), 'config.json'));
    expect(voiceFile('/voice-model/test/serve/../../../.claude.json', m)).toBeNull();
    expect(voiceFile('/voice-model/test/serve/tokenizer.json', m)).toBeNull();
    expect(voiceFile('/voice-model/other/config.json', m)).toBeNull();
  });
});
