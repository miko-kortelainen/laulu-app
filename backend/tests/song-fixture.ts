import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function configureTestSongStorage() {
  const env = {
    SUPABASE_URL: 'https://offline-storage.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_offline',
    R2_ACCOUNT_ID: '0'.repeat(32), R2_BUCKET_NAME: 'offline-songs',
    R2_ACCESS_KEY_ID: 'offline-access', R2_SECRET_ACCESS_KEY: 'offline-secret',
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const rows = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, Buffer>();
  const failures = { read: false, insert: false, put: false, ready: false, readyResponse: false, deleteObject: false, deleteRow: false };
  let writes = 0;
  let reads = 0;
  let deletes = 0;
  const send = mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof PutObjectCommand || command instanceof GetObjectCommand || command instanceof DeleteObjectCommand, 'only private object operations are permitted');
    assert.equal(command.input.Bucket, env.R2_BUCKET_NAME);
    const key = command.input.Key;
    assert.ok(key && /^users\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/.test(key));
    if (command instanceof DeleteObjectCommand) {
      deletes++;
      if (failures.deleteObject) throw new Error('offline R2 delete failure');
      objects.delete(key);
      return {};
    }
    if (command instanceof PutObjectCommand) {
      if (failures.put) throw new Error('offline R2 failure');
      assert.equal(command.input.ContentType, 'audio/mpeg');
      assert.ok(Buffer.isBuffer(command.input.Body));
      objects.set(key, Buffer.from(command.input.Body));
      writes++;
      return {};
    }
    reads++;
    const audio = objects.get(key);
    assert.ok(audio, 'object must exist');
    let content = audio;
    let ContentRange: string | undefined;
    if (command.input.Range) {
      const [first, last] = command.input.Range.replace('bytes=', '').split('-');
      const start = first ? Number(first) : Math.max(0, audio.length - Number(last));
      const end = first && last ? Math.min(Number(last), audio.length - 1) : audio.length - 1;
      if (start >= audio.length || end < start) throw Object.assign(new Error('invalid range'), { name: 'InvalidRange' });
      content = audio.subarray(start, end + 1);
      ContentRange = `bytes ${start}-${end}/${audio.length}`;
    }
    return { Body: { transformToByteArray: async () => content }, ContentRange };
  });

  async function databaseResponse(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== '/rest/v1/songs' || url.origin !== process.env.SUPABASE_URL) return undefined;
    assert.equal(request.headers.get('apikey'), env.SUPABASE_SECRET_KEY);
    const owner = url.searchParams.get('owner_id')?.replace(/^eq\./, '');
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    const status = url.searchParams.get('status')?.replace(/^eq\./, '');
    const matches = [...rows.values()].filter((row) => row.owner_id === owner && (!id || row.id === id) && (!status || row.status === status));
    if (request.method === 'GET') {
      assert.ok(owner, 'every read must filter by the verified owner');
      if (failures.read) return Response.json({ message: 'offline database read failure' }, { status: 503 });
      return Response.json(matches);
    }
    if (request.method === 'POST') {
      if (failures.insert) return Response.json({ message: 'offline insert failure' }, { status: 503 });
      const row: Record<string, unknown> = await request.json();
      assert.equal(typeof row.id, 'string');
      assert.equal(row.status, 'pending');
      assert.ok(!rows.has(row.id as string));
      rows.set(row.id as string, row);
      return new Response(null, { status: 201 });
    }
    if (request.method === 'DELETE') {
      assert.ok(owner && id, 'every deletion must filter by owner and id');
      if (failures.deleteRow) return Response.json({ message: 'offline database delete failure' }, { status: 503 });
      for (const row of matches) rows.delete(row.id as string);
      return new Response(null, { status: 204 });
    }
    assert.equal(request.method, 'PATCH');
    assert.ok(owner && id && status === 'pending', 'every update must filter owner, id, and state');
    if (failures.ready) return Response.json({ message: 'offline update failure' }, { status: 503 });
    assert.equal(matches.length, 1);
    assert.deepEqual(await request.json(), { status: 'ready' });
    const row = { ...matches[0], status: 'ready' };
    rows.set(id, row);
    if (failures.readyResponse) return Response.json({ message: 'lost update response' }, { status: 503 });
    return Response.json(row);
  }

  return { rows, objects, failures, databaseResponse, get writes() { return writes; }, get reads() { return reads; }, get deletes() { return deletes; },
    restore() {
      send.mock.restore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
