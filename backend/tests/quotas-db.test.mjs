import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const databaseURL = process.env.QUOTA_TEST_DATABASE_URL;
const psql = process.env.QUOTA_TEST_PSQL || 'psql';
const defaults = JSON.stringify({ chat_daily: 3, analysis_daily: 2, generation_daily: 3, storage_bytes: 100 });
const globalLimits = JSON.stringify({ chat: 100, analysis: 100, generation: 100 });

function query(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseURL], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors.trim())));
    child.stdin.end(sql);
  });
}

test('database quotas serialize reservations, survive new connections, and protect users', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a disposable, migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'use a disposable local database');
  assert.match(target.pathname, /^\/quota_test/, 'use a database named quota_test...');
  const owner = randomUUID();
  const other = randomUUID();
  const day = "(clock_timestamp() at time zone 'UTC')::date";
  const reserve = (operation, id = randomUUID(), bytes = 0, user = owner) =>
    query(`set role service_role; select public.reserve_usage('${user}', '${operation}', '${id}', ${bytes}, '${defaults}', '${globalLimits}');`).then(JSON.parse);
  const usage = () => query(`set role service_role; select public.get_usage('${owner}', '${defaults}');`).then(JSON.parse);
  const metadata = (id, bytes, user = owner) => ({ id, owner_id: user,
    object_key: `users/${user}/${id}.mp3`, prompt: 'offline folk', model: 'lyria-3.5', lyrics: '',
    size_bytes: bytes, status: 'pending', created_at: new Date().toISOString() });
  const save = (song) => query(`set role service_role; select public.prepare_song_save('${JSON.stringify(song)}', '${defaults}');`).then(JSON.parse);

  await query(`insert into auth.users(id) values ('${owner}'), ('${other}');`);
  try {
    // All callers use separate processes and database connections, rather than a JavaScript mock.
    const chats = await Promise.all(Array.from({ length: 12 }, () => reserve('chat')));
    assert.equal(chats.filter((result) => result.allowed).length, 3);
    assert.equal(chats.filter((result) => !result.allowed && result.resource === 'chat').length, 9);
    assert.equal((await usage()).chat.used, 3, 'new connections retain usage');
    assert.equal((await reserve('chat', randomUUID(), 0, other)).allowed, true, 'another owner has a separate allowance');
    const id = randomUUID();
    assert.equal((await reserve('analysis', id)).created, true);
    assert.equal((await reserve('analysis', id)).created, false, 'a replay does not consume again');
    await assert.rejects(reserve('analysis', id, 0, other), /another operation/);
    assert.equal((await usage()).analysis.used, 1);

    // Yesterday's reservations never move into today's allowance.
    await query(`update public.daily_usage set usage_date = ${day} - 1 where user_id = '${owner}' and operation = 'chat';
      update public.usage_reservations set usage_date = ${day} - 1 where user_id = '${owner}' and operation = 'chat';`);
    assert.equal((await usage()).chat.used, 0);
    assert.equal((await reserve('chat')).allowed, true);
    assert.equal(await query(`select used from public.daily_usage where user_id = '${owner}' and operation = 'chat' and usage_date = ${day} - 1;`), '3');

    const tracks = await Promise.all(Array.from({ length: 8 }, () => reserve('generation', randomUUID(), 60)));
    const first = tracks.find((result) => result.allowed);
    assert.ok(first);
    assert.equal(tracks.filter((result) => result.allowed).length, 1, 'only one storage reservation fits');
    assert.equal((await usage()).generation.used, 1, 'storage denials do not consume generation allowance');
    assert.equal((await usage()).storage.reserved, 60);
    const song = metadata(first.id, 40);
    assert.equal((await save(song)).allowed, true);
    assert.equal((await save(song)).allowed, true, 'storage retry is idempotent');
    assert.deepEqual((await usage()).storage, { limit: 100, used: 40, reserved: 0, remaining: 60 });
    assert.equal((await usage()).generation.used, 1, 'saving never charges a second generation');
    await query(`set role service_role; select public.release_song_reservation('${owner}', '${song.id}');`);
    assert.equal((await usage()).storage.used, 40, 'pending metadata retains storage after an R2 failure');
    await assert.rejects(save(metadata(song.id, 40, other)), /does not match/);

    const second = await reserve('generation', randomUUID(), 60);
    assert.equal(second.allowed, true);
    const usageBeforeRelease = await usage();
    await query(`set role service_role; select public.release_song_reservation('${other}', '${second.id}');`);
    assert.deepEqual(await usage(), usageBeforeRelease, 'another owner cannot release a reservation');
    await query(`set role service_role; select public.release_song_reservation('${owner}', '${second.id}');
      select public.release_song_reservation('${owner}', '${second.id}');`);
    assert.equal((await usage()).storage.reserved, 0);
    assert.equal((await usage()).generation.used, 2, 'provider failures keep the paid attempt');
    assert.equal((await reserve('generation', randomUUID(), 60)).allowed, true);
    assert.equal((await reserve('generation')).resource, 'generation');
    await query(`delete from public.songs where id = '${song.id}';`);
    assert.equal((await usage()).storage.used, 0, 'metadata deletion releases bytes exactly once');

    // Existing song metadata counts immediately, without a second counter or a backfill.
    const legacy = metadata(randomUUID(), 101, other);
    await query(`insert into public.songs select (jsonb_populate_record(null::public.songs, '${JSON.stringify(legacy)}')).*;`);
    assert.equal((await reserve('generation', randomUUID(), 1, other)).resource, 'storage');
    await query(`update public.user_quotas set chat_daily = 0 where user_id = '${other}';`);
    assert.equal((await reserve('chat', randomUUID(), 0, other)).resource, 'chat', 'per-user changes take effect immediately');

    for (const role of ['anon', 'authenticated']) {
      for (const table of ['user_quotas', 'daily_usage', 'usage_reservations', 'global_usage']) {
        await assert.rejects(query(`set role ${role}; select * from public.${table};`), /permission denied/);
        await assert.rejects(query(`set role ${role}; update public.${table} set ${table === 'global_usage' ? 'used = 0' : `user_id = '${other}'`};`), /permission denied/);
      }
      await assert.rejects(query(`set role ${role}; select public.reserve_usage('${owner}', 'chat', '${randomUUID()}', 0, '${defaults}', '${globalLimits}');`), /permission denied/);
      await assert.rejects(query(`set role ${role}; select public.get_usage('${owner}', '${defaults}');`), /permission denied/);
      await assert.rejects(query(`set role ${role}; select public.settle_generation('${owner}', '${song.id}', 'failed');`), /permission denied/);
      await assert.rejects(query(`set role ${role}; select public.prepare_song_save('${JSON.stringify(song)}', '${defaults}');`), /permission denied/);
    }
    assert.equal(await query("select count(*) from pg_class where relname in ('user_quotas', 'daily_usage', 'usage_reservations', 'global_usage') and relrowsecurity;"), '4');
    assert.equal(await query("select to_regprocedure('public.reserve_usage(uuid,text,uuid,bigint,jsonb)') is null;"), 't');
    assert.equal(await query("select count(*) from pg_proc where proname in ('quota_account', 'reserve_usage', 'release_song_reservation', 'settle_generation', 'prepare_song_save', 'get_usage') and prosecdef;"), '0');
  } finally {
    await query(`delete from public.songs where owner_id in ('${owner}', '${other}');
      delete from auth.users where id in ('${owner}', '${other}');`);
  }
});

test('beta allows 20 chats and five completed songs, refunds once, and retains the original UTC date', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a disposable, migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const other = randomUUID();
  const beta = JSON.stringify({ chat_daily: 20, analysis_daily: 10, generation_daily: 5, storage_bytes: 1000 });
  const reserve = (operation) => query(`set role service_role; select public.reserve_usage('${owner}', '${operation}', '${randomUUID()}', ${operation === 'generation' ? 100 : 0}, '${beta}', '${globalLimits}');`).then(JSON.parse);
  const usage = () => query(`set role service_role; select public.get_usage('${owner}', '${beta}');`).then(JSON.parse);
  const settle = (id, status, user = owner) => query(`set role service_role; select public.settle_generation('${user}', '${id}', '${status}');`);
  await query(`insert into auth.users(id) values ('${owner}'), ('${other}');`);
  try {
    const chats = await Promise.all(Array.from({ length: 25 }, () => reserve('chat')));
    assert.equal(chats.filter((result) => result.allowed).length, 20);
    assert.equal((await usage()).chat.remaining, 0);

    const tracks = await Promise.all(Array.from({ length: 12 }, () => reserve('generation')));
    const accepted = tracks.filter((result) => result.allowed);
    assert.equal(accepted.length, 5, 'concurrent requests cannot overspend');
    assert.equal((await usage()).storage.reserved, 500, 'unknown outcomes retain their storage');
    const globalBefore = await query("select used from public.global_usage where operation = 'generation';");
    const first = accepted[0].id;
    await settle(first, 'failed', other);
    assert.equal((await usage()).generation.used, 5, 'another owner cannot refund usage');
    await Promise.all(Array.from({ length: 8 }, () => settle(first, 'failed')));
    assert.equal((await usage()).generation.used, 4, 'concurrent refunds apply exactly once');
    assert.equal((await usage()).storage.reserved, 400);
    assert.equal(await query("select used from public.global_usage where operation = 'generation';"), globalBefore, 'global attempts are never refunded');
    const replacement = await reserve('generation');
    assert.equal(replacement.allowed, true);
    for (const track of [...accepted.slice(1), replacement]) await settle(track.id, 'completed');
    assert.equal((await reserve('generation')).resource, 'generation', 'five completed songs exhaust the allowance');
    await settle(replacement.id, 'failed');
    assert.equal((await usage()).generation.used, 5, 'completion cannot later become a failure');

    const savedId = accepted[1].id;
    const song = { id: savedId, owner_id: owner, object_key: `users/${owner}/${savedId}.mp3`,
      prompt: 'offline folk', model: 'lyria-3.5', lyrics: '', size_bytes: 50, status: 'pending', created_at: new Date().toISOString() };
    const save = () => query(`set role service_role; select public.prepare_song_save('${JSON.stringify(song)}', '${beta}');`).then(JSON.parse);
    assert.equal((await save()).allowed, true);
    assert.equal((await save()).allowed, true);
    assert.equal((await usage()).generation.used, 5, 'save retries do not charge again');
    await query(`delete from public.songs where id = '${savedId}';`);
    await settle(savedId, 'failed');
    assert.equal((await usage()).generation.used, 5, 'deleting a song never refunds generation');

    // Simulate a request that started yesterday and completes or fails today.
    await query(`update public.daily_usage set usage_date = usage_date - 1 where user_id = '${owner}' and operation = 'generation';
      update public.usage_reservations set usage_date = usage_date - 1 where user_id = '${owner}' and operation = 'generation';`);
    const yesterday = await reserve('generation');
    await query(`update public.usage_reservations set usage_date = usage_date - 1 where id = '${yesterday.id}';
      update public.daily_usage set used = used + 1 where user_id = '${owner}' and operation = 'generation' and usage_date = (clock_timestamp() at time zone 'UTC')::date - 1;
      delete from public.daily_usage where user_id = '${owner}' and operation = 'generation' and usage_date = (clock_timestamp() at time zone 'UTC')::date;`);
    const today = await reserve('generation');
    await settle(today.id, 'completed');
    await settle(yesterday.id, 'failed');
    await settle(yesterday.id, 'failed');
    assert.equal((await usage()).generation.used, 1, 'a late refund never changes today');
    assert.equal(await query(`select used from public.daily_usage where user_id = '${owner}' and operation = 'generation' and usage_date = (clock_timestamp() at time zone 'UTC')::date - 1;`), '5');
    const last = await reserve('generation');
    await settle(last.id, 'failed');
    await assert.rejects(settle(last.id, 'reserved'), /invalid generation status/);
    const single = await query(`set role service_role; select public.reserve_usage('${other}', 'generation', '${randomUUID()}', 100, '${beta}', '${globalLimits}');`).then(JSON.parse);
    await settle(single.id, 'failed', other);
    await settle(single.id, 'failed', other);
    const empty = await query(`set role service_role; select public.get_usage('${other}', '${beta}');`).then(JSON.parse);
    assert.equal(empty.generation.used, 0, 'refunding the last song removes the daily counter without going negative');
    assert.equal(empty.generation.remaining, 5);
  } finally {
    await query(`delete from public.songs where owner_id = '${owner}'; delete from auth.users where id in ('${owner}', '${other}');`);
  }
});

test('global limits serialize different accounts and survive account deletion and UTC rollover', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a disposable, migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const users = Array.from({ length: 4 }, () => randomUUID());
  const limits = JSON.stringify({ chat: 0, analysis: 5, generation: 5 });
  const accounts = JSON.stringify({ chat_daily: 100, analysis_daily: 100, generation_daily: 100, storage_bytes: 0 });
  const reserve = (user, operation, id = randomUUID(), bytes = 0, caps = limits) =>
    query(`set role service_role; select public.reserve_usage('${user}', '${operation}', '${id}', ${bytes}, '${accounts}', '${caps}');`).then(JSON.parse);
  await query(`insert into auth.users(id) values ${users.map((id) => `('${id}')`).join(',')};
    update public.global_usage set usage_date = (clock_timestamp() at time zone 'UTC')::date - 1;`);
  try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => reserve(users[index % users.length], 'analysis')));
    assert.equal(results.filter((result) => result.allowed).length, 5);
    assert.equal(results.filter((result) => !result.allowed && result.scope === 'global').length, 11);
    assert.equal(await query("select used from public.global_usage where operation = 'analysis';"), '5');
    const successful = results.find((result) => result.allowed);
    const owner = await query(`select user_id from public.usage_reservations where id = '${successful.id}';`);
    assert.equal((await reserve(owner, 'analysis', successful.id)).created, false);
    assert.equal(await query("select used from public.global_usage where operation = 'analysis';"), '5');
    await query(`delete from auth.users where id = '${owner}';`);
    const remaining = users.find((id) => id !== owner);
    const denied = await reserve(remaining, 'analysis');
    assert.equal(denied.scope, 'global', 'deleting an account does not restore global allowance');
    assert.equal(new Date(denied.resetAt).getUTCHours(), 0);
    assert.equal((await reserve(remaining, 'chat')).scope, 'global', 'zero disables an operation');
    assert.equal((await reserve(remaining, 'generation', randomUUID(), 1)).resource, 'storage');
    assert.equal(await query(`select count(*) from public.usage_reservations where user_id = '${remaining}' and operation in ('chat', 'generation');`), '0');
    await assert.rejects(reserve(remaining, 'analysis', randomUUID(), 0, '{}'), /invalid global allowance/);
    await query("update public.global_usage set usage_date = usage_date - 1 where operation = 'analysis';");
    assert.equal((await reserve(remaining, 'analysis')).allowed, true);
    assert.equal(await query("select used from public.global_usage where operation = 'analysis';"), '1');
    await query(`update public.user_quotas set analysis_daily = 0 where user_id = '${remaining}';`);
    assert.equal((await reserve(remaining, 'analysis')).resource, 'analysis');
    assert.equal(await query("select used from public.global_usage where operation = 'analysis';"), '1', 'per-user denials do not consume global usage');
  } finally {
    await query(`delete from auth.users where id in (${users.map((id) => `'${id}'`).join(',')});`);
  }
});
