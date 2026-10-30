import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { powershell } from './boards.js';
import { configPath } from './settings.js';

export interface Monitor { index: number; name: string; width: number; height: number; left: number; top: number; primary: boolean }
export interface Tools { ffmpeg: { path: string; version: string } | null; monitors: Monitor[] }

const MONITORS_PS = `Add-Type -AssemblyName System.Windows.Forms
ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Screen]::AllScreens | % { [pscustomobject]@{ name = $_.DeviceName; width = $_.Bounds.Width; height = $_.Bounds.Height; left = $_.Bounds.X; top = $_.Bounds.Y; primary = $_.Primary } })`;

function configured(repo?: string): string {
  try {
    const p = JSON.parse(readFileSync(configPath('settings', repo), 'utf8'))?.recording?.ffmpeg;
    return typeof p === 'string' && p.trim() ? p.trim() : 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

function ffmpeg(path: string): Promise<Tools['ffmpeg']> {
  return new Promise((ok) => {
    try {
      execFile(path, ['-version'], { timeout: 10_000, windowsHide: true }, (e, out) => {
        const line = String(out).split(/\r?\n/)[0].trim();
        ok(e || !line ? null : { path, version: /version (\S+)/.exec(line)?.[1] ?? line });
      });
    } catch {
      ok(null);
    }
  });
}

async function monitors(): Promise<Monitor[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { ok, out } = await powershell(MONITORS_PS);
    if (!ok) return [];
    const list = [JSON.parse(out)].flat() as Omit<Monitor, 'index'>[];
    return list.map((m, index) => ({ index, name: m.name, width: m.width, height: m.height, left: m.left, top: m.top, primary: m.primary }));
  } catch {
    return [];
  }
}

export async function tools(repo?: string): Promise<Tools> {
  const [f, m] = await Promise.all([ffmpeg(configured(repo)), monitors()]);
  return { ffmpeg: f, monitors: m };
}
