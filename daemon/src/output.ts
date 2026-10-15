import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const outputDir = (repo: string) => join(repo, '.kanban95', 'output');
export const outputPath = (repo: string, runId: number) => join(outputDir(repo), `${runId}.txt.gz`);

export function saveOutput(repo: string, runId: number, text: string): void {
  mkdirSync(outputDir(repo), { recursive: true });
  writeFileSync(outputPath(repo, runId), gzipSync(text));
}

export const hasOutput = (repo: string, runId: number) => existsSync(outputPath(repo, runId));

export function readOutput(repo: string, runId: number): string | null {
  const path = outputPath(repo, runId);
  return existsSync(path) ? gunzipSync(readFileSync(path)).toString('utf8') : null;
}
