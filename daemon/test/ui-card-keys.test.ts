import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, ticket, column } from './ui.ts';

const KEYS: Record<string, [string, number]> = { Enter: ['Enter', 13], ' ': ['Space', 32], ArrowDown: ['ArrowDown', 40], ArrowRight: ['ArrowRight', 39] };
const press = async (key: string) => {
  const [code, keyCode] = KEYS[key];
  const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
};
const focusedId = () => page.evaluate<string | null>(`document.activeElement?.closest?.('.card')?.dataset.id ?? null`);
const focusCard = (id: number) => page.evaluate(`document.querySelector('.card[data-id="${id}"]').focus()`);

describe('ui-card-keys', { timeout: 60_000 }, () => {
  it('moves focus with the arrows, toggles selection with Space and opens the ticket with Enter', async () => {
    const a = ticket('First');
    const b = ticket('Second');
    const c = ticket('Running', { status: 'in_progress' });
    await page.goto(base);
    await until(async () => (await column(a)) === 'backlog' && (await column(c)) === 'in_progress', 'the cards');

    await focusCard(a);
    expect(await page.evaluate<string>(`getComputedStyle(document.activeElement).outlineStyle`)).not.toBe('none');

    await press('ArrowDown');
    await until(async () => (await focusedId()) === String(b), 'the second card focused');

    const selected = `document.querySelector('.card[data-id="${b}"]').classList.contains('selected')`;
    await press(' ');
    await until(() => page.evaluate<boolean>(selected), 'the card selected');
    await press(' ');
    await until(async () => !(await page.evaluate<boolean>(selected)), 'the card deselected');
    expect(await focusedId()).toBe(String(b));

    await press('ArrowRight');
    await until(async () => (await focusedId()) === String(c), 'the In Progress card focused');

    await press('Enter');
    await until(() => page.evaluate<boolean>(`!!document.querySelector('[data-win="ticket-${c}"]')`), 'the ticket window');
  });
});
