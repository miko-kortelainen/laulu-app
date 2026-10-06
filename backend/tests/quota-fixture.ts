import assert from 'node:assert/strict';

export function configureTestQuotas() {
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_offline';
  const reservations = new Map<string, { userId: string; operation: string; storageBytes: number }>();
  const failures: { unavailable: boolean; resource?: string; invalid: boolean } = { unavailable: false, invalid: false };

  async function databaseResponse(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.origin !== process.env.SUPABASE_URL || !url.pathname.startsWith('/rest/v1/rpc/')) return undefined;
    const name = url.pathname.split('/').at(-1);
    if (!['reserve_usage', 'release_song_reservation', 'get_usage'].includes(name ?? '')) return undefined;
    assert.equal(request.headers.get('apikey'), 'sb_secret_offline');
    const input: Record<string, unknown> = await request.json();
    assert.equal(typeof input.p_user_id, 'string');
    if (failures.unavailable) return Response.json({ message: 'offline quota database failure' }, { status: 503 });
    if (failures.invalid) return Response.json({});
    if (name === 'reserve_usage') {
      if (failures.resource) return Response.json({ allowed: false, resource: failures.resource,
        resetAt: failures.resource === 'storage' ? undefined : '2099-01-01T00:00:00Z' });
      assert.equal(typeof input.p_id, 'string');
      assert.ok(['chat', 'analysis', 'generation'].includes(input.p_operation as string));
      assert.ok(Number.isSafeInteger(input.p_storage_bytes));
      reservations.set(input.p_id as string, { userId: input.p_user_id as string,
        operation: input.p_operation as string, storageBytes: input.p_storage_bytes as number });
      return Response.json({ allowed: true, id: input.p_id, created: true });
    }
    if (name === 'release_song_reservation') {
      const reservation = reservations.get(input.p_id as string);
      assert.ok(reservation);
      assert.equal(reservation?.userId, input.p_user_id);
      reservation.storageBytes = 0;
      return new Response(null, { status: 204 });
    }
    const owned = [...reservations.values()].filter((entry) => entry.userId === input.p_user_id);
    const allowance = (operation: string) => {
      const used = owned.filter((entry) => entry.operation === operation).length;
      return { limit: 50, used, remaining: Math.max(0, 50 - used) };
    };
    return Response.json({ resetAt: '2099-01-01T00:00:00Z', chat: allowance('chat'), analysis: allowance('analysis'),
      generation: allowance('generation'), storage: { limit: 536870912, used: 0,
        reserved: owned.reduce((sum, entry) => sum + entry.storageBytes, 0), remaining: 536870912 } });
  }

  return { reservations, failures, databaseResponse, restore() {
    if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = previousKey;
  } };
}
