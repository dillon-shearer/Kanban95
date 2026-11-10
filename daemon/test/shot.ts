import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { webkit } from 'playwright';
import { OPEN, shotArgs, withBoard } from './shot-board.ts';

const { out, zoom, open } = shotArgs('shot', [...OPEN, 'prompts']);
const browser = await webkit.launch({ headless: true });
const code = await withBoard(zoom, async (login, base) => {
  if (open === 'prompts') writeFileSync(join(process.env.KANBAN95_HOME!, 'snippets.json'), JSON.stringify([
    { name: 'Brief replies', text: 'Keep replies brief.', on: true },
    { name: 'ASCII only', text: 'Use ASCII characters only.', on: false },
  ]));
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(login);
  await page.waitForURL(base);
  await page.locator('.k95-board .card').first().waitFor();
  await page.locator('#tasks .task').nth(2).waitFor();
  if (open === 'start') await page.locator('#start').click();
  if (open === 'switch') await page.locator('#switch').click();
  if (open === 'taskmenu') await page.locator('[data-task="board"]').click({ button: 'right' });
  if (open === 'start' || open === 'taskmenu') await page.locator('.k95-menu').first().waitFor();
  if (open === 'switch') await page.locator('.k95-switch').waitFor();
  if (open === 'prompts') {
    await page.locator('[data-icon="Settings"]').dblclick();
    await page.locator('[data-win="settings"] [role=tab] a', { hasText: 'Prompts' }).click();
    await page.locator('#snippets .k95-snippets .field-row').first().waitFor();
    await page.locator('#snippets').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  }
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
});
await browser.close();
process.exit(code);
