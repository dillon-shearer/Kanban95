import './home.ts';
import { describe, expect, it } from 'vitest';
import { db, send, t, ticket } from './board.ts';

const del = send('DELETE');
const dep = (from: number, on: number) => db.prepare('INSERT INTO ticket_deps (ticket_id, depends_on_id) VALUES (?, ?)').run(from, on);

describe('deleting a ticket others depend on', () => {
  it('is refused with a plain message naming every dependent, and keeps the ticket', async () => {
    const id = ticket('Base');
    const a = ticket('Needs base');
    const b = ticket('Also needs base');
    dep(a, id);
    dep(b, id);
    const r = await del(`/api/tickets/${id}`);
    expect(r.status).toBe(400);
    const { error } = (await r.json()) as { error: string };
    expect(error).toBe(`#${a}, #${b} depend on #${id}. Remove #${id} from their depends on list first.`);
    expect(error).not.toMatch(/constraint|FOREIGN KEY/i);
    expect(t(id).title).toBe('Base');
  });

  it('goes through once nothing depends on it', async () => {
    const id = ticket('Base');
    const a = ticket('Needs base');
    dep(a, id);
    expect((await del(`/api/tickets/${a}`)).status).toBe(204);
    expect((await del(`/api/tickets/${id}`)).status).toBe(204);
    expect(db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(id)).toBeUndefined();
  });
});
