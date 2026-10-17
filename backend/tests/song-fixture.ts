import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { configureTestQuotas } from './quota-fixture.js';
import { isRecord } from '../src/validation.js';
import { TERMS_VERSION } from '../src/terms.js';

export function configureTestSongStorage() {
  const env = {
    SUPABASE_URL: 'https://offline-storage.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_offline',
    R2_ACCOUNT_ID: '0'.repeat(32), R2_BUCKET_NAME: 'offline-songs',
    R2_ACCESS_KEY_ID: 'offline-access', R2_SECRET_ACCESS_KEY: 'offline-secret',
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const quotas = configureTestQuotas();
  const rows = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, Buffer>();
  const failures = { read: false, insert: false, put: false, ready: false, readyResponse: false, deleteObject: false, deleteRow: false, favourite: false };
  let writes = 0;
  let reads = 0;
  let deletes = 0;
  const send = mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof PutObjectCommand || command instanceof GetObjectCommand || command instanceof DeleteObjectCommand, 'only private object operations are permitted');
    assert.equal(command.input.Bucket, env.R2_BUCKET_NAME);
    const key = command.input.Key;
    assert.ok(key && /^users\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/.test(key));
    if (command instanceof DeleteObjectCommand) return deleteObject(key);
    if (command instanceof PutObjectCommand) return putObject(command, key);
    reads++;
    const audio = objects.get(key);
    assert.ok(audio, 'object must exist');
    return objectResponse(audio, command.input.Range);
  });

  function deleteObject(key: string): object {
    deletes++;
    if (failures.deleteObject) throw new Error('offline R2 delete failure');
    objects.delete(key);
    return {};
  }

  function putObject(command: PutObjectCommand, key: string): object {
    if (failures.put) throw new Error('offline R2 failure');
    assert.equal(command.input.ContentType, 'audio/mpeg');
    assert.ok(Buffer.isBuffer(command.input.Body));
    objects.set(key, Buffer.from(command.input.Body));
    writes++;
    return {};
  }

  async function databaseResponse(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const quotaResponse = await quotas.databaseResponse(request.clone());
    if (quotaResponse) return quotaResponse;
    if (url.origin === process.env.SUPABASE_URL && url.pathname === '/rest/v1/terms_acceptances') {
      assert.equal(request.method, 'GET');
      assert.equal(url.searchParams.get('version'), `eq.${TERMS_VERSION}`);
      assert.ok(url.searchParams.get('user_id'), 'acceptance must belong to the verified user');
      return Response.json([{ version: TERMS_VERSION }]);
    }
    if (url.origin === process.env.SUPABASE_URL && url.pathname === '/rest/v1/rpc/prepare_song_save') {
      return prepareSong(request);
    }
    if (url.pathname !== '/rest/v1/songs' || url.origin !== process.env.SUPABASE_URL) return undefined;
    return songResponse(request, url);
  }

  async function songResponse(request: Request, url: URL): Promise<Response> {
    assert.equal(request.headers.get('apikey'), env.SUPABASE_SECRET_KEY);
    const owner = url.searchParams.get('owner_id')?.replace(/^eq\./, '');
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    const status = url.searchParams.get('status')?.replace(/^eq\./, '');
    const identity = { owner, id, status };
    const matches = [...rows.values()].filter(row => matchesSong(row, identity));
    if (request.method === 'GET') return readSongs(matches, owner);
    if (request.method === 'DELETE') return deleteSongs(matches, identity);
    assert.equal(request.method, 'PATCH');
    const patch: unknown = await request.json();
    if (isRecord(patch) && 'is_favourite' in patch) return favouriteResponse(patch, matches, identity);
    return readyResponse(patch, matches, identity);
  }

  function readyResponse(patch: unknown, matches: Record<string, unknown>[], { owner, id, status }: {
    owner?: string; id?: string; status?: string;
  }): Response {
    assert.ok(owner && id && status === 'pending', 'every update must filter owner, id, and state');
    if (failures.ready) return Response.json({ message: 'offline update failure' }, { status: 503 });
    assert.equal(matches.length, 1);
    assert.deepEqual(patch, { status: 'ready' });
    const row = { ...matches[0], status: 'ready' };
    rows.set(id, row);
    if (failures.readyResponse) return Response.json({ message: 'lost update response' }, { status: 503 });
    return Response.json(row);
  }

  function favouriteResponse(patch: Record<string, unknown>, matches: Record<string, unknown>[], { owner, id, status }: {
    owner?: string; id?: string; status?: string;
  }): Response {
    assert.ok(owner && id && status === 'ready', 'favourites must filter owner, id, and ready state');
    assert.equal(typeof patch.is_favourite, 'boolean');
    assert.deepEqual(Object.keys(patch), ['is_favourite']);
    if (failures.favourite) return Response.json({ message: 'offline favourite failure' }, { status: 503 });
    const row = matches[0] ? { ...matches[0], is_favourite: patch.is_favourite } : null;
    if (row) rows.set(id, row);
    return Response.json(row);
  }

  function readSongs(matches: Record<string, unknown>[], owner: string | undefined): Response {
    assert.ok(owner, 'every read must filter by the verified owner');
    if (failures.read) return Response.json({ message: 'offline database read failure' }, { status: 503 });
    return Response.json(matches);
  }

  function deleteSongs(matches: Record<string, unknown>[], { owner, id }: { owner?: string; id?: string }): Response {
    assert.ok(owner && id, 'every deletion must filter by owner and id');
    if (failures.deleteRow) return Response.json({ message: 'offline database delete failure' }, { status: 503 });
    for (const row of matches) rows.delete(row.id as string);
    return new Response(null, { status: 204 });
  }

  async function prepareSong(request: Request): Promise<Response> {
    assert.equal(request.headers.get('apikey'), env.SUPABASE_SECRET_KEY);
    if (failures.insert) return Response.json({ message: 'offline insert failure' }, { status: 503 });
    const { p_song: row }: { p_song: Record<string, unknown> } = await request.json();
    assert.equal(row.status, 'pending');
    const id = row.id as string;
    if (!rows.has(id)) rows.set(id, { ...row, is_favourite: false });
    const reservation = quotas.reservations.get(id);
    if (reservation) reservation.storageBytes = 0;
    return Response.json({ allowed: true, song: rows.get(id) });
  }

  return { rows, objects, failures, quotas, databaseResponse, get writes() { return writes; }, get reads() { return reads; }, get deletes() { return deletes; },
    restore() {
      quotas.restore();
      send.mock.restore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function objectResponse(audio: Buffer, range: string | undefined) {
  let content = audio;
  let ContentRange: string | undefined;
  if (range) {
    const [first, last] = range.replace('bytes=', '').split('-');
    const start = first ? Number(first) : Math.max(0, audio.length - Number(last));
    const end = first && last ? Math.min(Number(last), audio.length - 1) : audio.length - 1;
    if (start >= audio.length || end < start) throw Object.assign(new Error('invalid range'), { name: 'InvalidRange' });
    content = audio.subarray(start, end + 1);
    ContentRange = `bytes ${start}-${end}/${audio.length}`;
  }
  return { Body: { transformToByteArray: async () => content }, ContentRange };
}

function matchesSong(row: Record<string, unknown>, { owner, id, status }: { owner?: string; id?: string; status?: string }): boolean {
  return row.owner_id === owner && (!id || row.id === id) && (!status || row.status === status);
}
