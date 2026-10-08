import assert from 'node:assert/strict';
import { configureTestSongStorage } from './song-fixture.js';

export function configureTestOperations() {
  const storage = configureTestSongStorage();
  const operations = new Map<string, Record<string, unknown>>();
  const hooks: { insert?: () => Promise<void>; unavailable?: boolean } = {};
  async function databaseResponse(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.origin !== process.env.SUPABASE_URL) return undefined;
    if (url.pathname === '/rest/v1/operations') {
      if (hooks.unavailable) return Response.json({ message: 'offline' }, { status: 503 });
      const owner = url.searchParams.get('owner_id')?.replace('eq.', '');
      const id = url.searchParams.get('id')?.replace('eq.', '');
      const rows = [...operations.values()].filter((row) => (!owner || row.owner_id === owner) && (!id || row.id === id));
      if (request.method === 'POST') {
        const row = await request.json() as Record<string, unknown>;
        if (operations.has(row.id as string)) return Response.json({ code: '23505' }, { status: 409 });
        const saved = { state: 'queued', status: '', result: null, acknowledged: false, created_at: new Date().toISOString(), ...row };
        operations.set(row.id as string, saved);
        await hooks.insert?.();
        return Response.json(saved);
      }
      if (request.method === 'PATCH') {
        assert.ok(owner && id, 'updates require owner and operation ID');
        const patch = await request.json() as Record<string, unknown>;
        for (const row of rows) operations.set(row.id as string, { ...row, ...patch });
        return new Response(null, { status: 204 });
      }
      return Response.json(rows.filter((row) => url.searchParams.get('acknowledged') !== 'eq.false' || !row.acknowledged));
    }
    if (url.pathname === '/rest/v1/usage_reservations') {
      const owner = url.searchParams.get('user_id')?.replace('eq.', '');
      const id = url.searchParams.get('id')?.replace('eq.', '');
      const reservation = storage.quotas.reservations.get(id ?? '');
      return Response.json(reservation?.userId === owner ? [{ generation_status: reservation.status }] : []);
    }
    if (url.pathname === '/rest/v1/rpc/cleanup_operations' || url.pathname === '/rest/v1/rpc/release_song_reservation') {
      return new Response(null, { status: 204 });
    }
    return storage.databaseResponse(request);
  }
  return { ...storage, operations, hooks, databaseResponse };
}
