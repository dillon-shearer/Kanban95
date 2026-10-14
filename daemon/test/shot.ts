import { webkit } from 'playwright';
import { shotArgs, withBoard } from './shot-board.ts';

const { out, zoom, open } = shotArgs('shot');
const browser = await webkit.launch({ headless: true });
const code = await withBoard(zoom, async (login, base) => {
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
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
});
await browser.close();
process.exit(code);
