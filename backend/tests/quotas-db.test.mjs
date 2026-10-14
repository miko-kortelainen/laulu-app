import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const databaseURL = process.env.QUOTA_TEST_DATABASE_URL;
const psql = process.env.QUOTA_TEST_PSQL || 'psql';
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

test('individual usage resets preserve allowances, owners, songs, and late generation settlement', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const other = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 26);
  assert.equal(await query(`begin;
    set local plpgsql.check_asserts = on;
    insert into auth.users(id) values ('${owner}'), ('${other}');
    set local role service_role;
    do $$
    declare
      pending_id uuid := gen_random_uuid();
      saved_id uuid := gen_random_uuid();
      lyric_id uuid := gen_random_uuid();
      old_period_id uuid := gen_random_uuid();
      event_time timestamptz := clock_timestamp();
      period_start timestamptz := event_time - interval '1 hour';
      before_reset jsonb;
      usage jsonb;
      result jsonb;
      global_used integer;
      i integer;
    begin
      assert not has_function_privilege('anon', 'public.reset_user_usage(uuid,text)', 'execute');
      assert not has_function_privilege('authenticated', 'public.reset_user_usage(uuid,text)', 'execute');
      update public.global_usage set usage_date = (clock_timestamp() at time zone 'UTC')::date, used = 0;
      perform public.reserve_usage('${owner}', 'chat', gen_random_uuid(), 0, '{}', '${globalLimits}');
      perform public.reserve_usage('${owner}', 'analysis', gen_random_uuid(), 0, '{}', '${globalLimits}');
      perform public.reserve_usage('${owner}', 'generation', pending_id, 100, '{}', '${globalLimits}');
      perform public.reserve_usage('${owner}', 'generation', saved_id, 0, '{}', '${globalLimits}');
      insert into public.songs(id, owner_id, object_key, prompt, model, size_bytes, status)
        values (saved_id, '${owner}', 'users/${owner}/' || saved_id || '.mp3', 'offline folk', 'lyria-3.5', 100, 'ready');
      perform public.settle_generation('${owner}', saved_id, 'completed');
      perform public.reserve_lyrics('${owner}', lyric_id);
      perform public.reserve_lyrics('${other}', gen_random_uuid());
      before_reset := public.get_usage('${owner}', '{}');
      result := public.reset_user_usage('${owner}', 'lyrics');
      assert (result->>'used')::integer = 0 and result->'limit' = before_reset->'lyrics'->'limit';
      usage := public.get_usage('${owner}', '{}');
      assert usage->'chat' = before_reset->'chat' and usage->'analysis' = before_reset->'analysis';
      assert usage->'generation' = before_reset->'generation' and usage->'storage' = before_reset->'storage';
      assert (public.get_usage('${other}', '{}')->'lyrics'->>'used')::integer = 1, 'another user is unchanged';
      assert (public.reserve_lyrics('${owner}', lyric_id)->>'created')::boolean = false, 'old requests stay idempotent';
      result := public.reserve_lyrics('${owner}', gen_random_uuid());
      assert (result->>'allowed')::boolean, 'reset permits the next lyric request';
      assert (public.get_usage('${owner}', '{}')->'lyrics'->>'used')::integer = 1;
      perform public.reset_user_usage('${owner}', 'chat');
      perform public.reset_user_usage('${owner}', 'analysis');
      usage := public.get_usage('${owner}', '{}');
      assert (usage->'chat'->>'used')::integer = 0 and (usage->'analysis'->>'used')::integer = 0;
      assert (usage->'lyrics'->>'used')::integer = 1, 'each reset affects only its selected operation';
      select sum(used) into global_used from public.global_usage;
      result := public.reset_user_usage('${owner}', 'generation');
      assert (result->>'used')::integer = 0 and result->'limit' = before_reset->'generation'->'limit';
      assert (public.get_usage('${owner}', '{}')->'storage') = before_reset->'storage', 'saved and reserved bytes stay intact';
      assert (select sum(used) = global_used from public.global_usage), 'global attempts are not reset';
      assert (select generation_status = 'reserved' and storage_bytes = 100 from public.usage_reservations where id = pending_id);
      assert exists (select 1 from public.songs where id = saved_id), 'saved songs survive';
      perform public.reserve_usage('${owner}', 'generation', gen_random_uuid(), 0, '{}', '${globalLimits}');
      perform public.settle_generation('${owner}', pending_id, 'failed');
      assert (public.get_usage('${owner}', '{}')->'generation'->>'used')::integer = 1,
        'late refunds from reset reservations cannot erase new daily usage';
      assert (select storage_bytes = 0 from public.usage_reservations where id = pending_id), 'late failures still release storage';

      perform public.register_paddle_checkout('txn_${suffix}', '${owner}');
      perform public.sync_paddle_event('subscription', jsonb_build_object('id', 'sub_${suffix}',
        'customer_id', 'ctm_${suffix}', 'transaction_id', 'txn_${suffix}', 'status', 'active', 'plan', 'starter',
        'period_start', period_start, 'period_end', period_start + interval '1 month', 'updated_at', event_time), event_time);
      insert into public.usage_reservations(id, user_id, usage_date, operation, billing_subscription_id, billing_period_start)
        values (old_period_id, '${owner}', (event_time at time zone 'UTC')::date, 'lyrics', 'sub_${suffix}', period_start - interval '1 month');
      for i in 1..10 loop
        lyric_id := gen_random_uuid();
        result := public.reserve_lyrics('${owner}', lyric_id);
        assert (result->>'allowed')::boolean;
      end loop;
      assert not (public.reserve_lyrics('${owner}', gen_random_uuid())->>'allowed')::boolean, 'monthly lyrics are exhausted';
      result := public.reset_user_usage('${owner}', 'lyrics');
      assert result = jsonb_build_object('used', 0, 'limit', 10, 'remaining', 10), '10/10 becomes 0/10';
      assert (select count(*) = 10 from public.usage_reservations where user_id = '${owner}' and operation = 'lyrics'
        and billing_subscription_id = 'sub_${suffix}' and billing_period_start = period_start and quota_reset),
        'monthly usage is forgiven without deleting reservations';
      assert (select not quota_reset from public.usage_reservations where id = old_period_id), 'previous billing periods stay intact';
      assert public.reset_user_usage('${owner}', 'lyrics') = result, 'repeating a reset is harmless';
      assert not (public.reserve_lyrics('${owner}', lyric_id)->>'created')::boolean;
      assert (public.get_usage('${owner}', '{}')->'lyrics'->>'used')::integer = 0;
      assert (public.reserve_lyrics('${owner}', gen_random_uuid())->>'allowed')::boolean;
      assert (public.get_usage('${owner}', '{}')->'lyrics'->>'used')::integer = 1;

      pending_id := gen_random_uuid();
      perform public.reserve_usage('${owner}', 'generation', pending_id, 100, '{}', '${globalLimits}');
      before_reset := public.get_usage('${owner}', '{}');
      result := public.reset_user_usage('${owner}', 'generation');
      assert (result->>'used')::integer = 0 and result->'limit' = before_reset->'generation'->'limit';
      assert (public.get_usage('${owner}', '{}')->'storage') = before_reset->'storage';
      perform public.reserve_usage('${owner}', 'generation', gen_random_uuid(), 0, '{}', '${globalLimits}');
      perform public.settle_generation('${owner}', pending_id, 'failed');
      usage := public.get_usage('${owner}', '{}');
      assert (usage->'generation'->>'used')::integer = 1 and (usage->'lyrics'->>'used')::integer = 1;
      assert usage->>'plan' = 'starter', 'resets do not change subscriptions';
      begin
        perform public.reset_user_usage('${owner}', 'storage');
        raise exception 'storage reset must be rejected';
      exception when others then
        assert sqlerrm = 'invalid usage reset';
      end;
    end;
    $$;
    rollback;`), '');
});

test('downgrades retain the paid tier through cancellation scheduling and switch at renewal', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 26);
  assert.equal(await query(`begin;
    set local plpgsql.check_asserts = on;
    insert into auth.users(id) values ('${owner}');
    set local role service_role;
    do $$
    declare
      event_time timestamptz := clock_timestamp();
      payload jsonb;
      billing jsonb;
    begin
      perform public.register_paddle_checkout('txn_${suffix}', '${owner}');
      payload := jsonb_build_object('id', 'sub_${suffix}', 'customer_id', 'ctm_${suffix}',
        'transaction_id', 'txn_${suffix}', 'status', 'active', 'plan', 'pro',
        'period_start', event_time, 'period_end', event_time + interval '1 month', 'updated_at', event_time);
      perform public.sync_paddle_event('subscription', payload, event_time);
      payload := payload || jsonb_build_object('plan', 'starter', 'updated_at', event_time + interval '1 minute');
      perform public.sync_paddle_event('subscription', payload, event_time + interval '1 minute');
      billing := public.get_billing('${owner}');
      assert billing->>'plan' = 'pro', 'a downgrade keeps the paid allowances';
      assert billing->'scheduledChange'->>'plan' = 'starter', 'the next tier stays visible';
      payload := payload || jsonb_build_object('updated_at', event_time + interval '2 minutes',
        'scheduled_change', jsonb_build_object('action', 'cancel', 'effectiveAt', event_time + interval '1 month'));
      perform public.sync_paddle_event('subscription', payload, event_time + interval '2 minutes');
      billing := public.get_billing('${owner}');
      assert billing->>'plan' = 'pro' and billing->'scheduledChange'->>'action' = 'cancel',
        'cancellation keeps paid access and takes precedence over the pending downgrade';
      payload := payload || jsonb_build_object('scheduled_change', null, 'updated_at', event_time + interval '3 minutes');
      perform public.sync_paddle_event('subscription', payload, event_time + interval '3 minutes');
      payload := payload || jsonb_build_object('period_start', event_time + interval '1 month',
        'period_end', event_time + interval '2 months', 'scheduled_change', null,
        'updated_at', event_time + interval '1 month');
      perform public.sync_paddle_event('subscription', payload, event_time + interval '1 month');
      billing := public.get_billing('${owner}');
      assert billing->>'plan' = 'starter' and billing->'scheduledChange' = 'null'::jsonb, 'renewal applies the lower tier';
    end;
    $$;
    rollback;`), '');
});

test('billing preserves newer state, resets monthly allowances, and refunds the original period once', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'billing checks require a local database');
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const paddleId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const customer = paddleId('ctm');
  const canceled = paddleId('sub');
  const subscription = paddleId('sub');
  const canceledTransaction = paddleId('txn');
  const transaction = paddleId('txn');

  // Fixtures exist only inside this transaction; errors also roll back when psql closes.
  assert.equal(await query(`begin;
    set local plpgsql.check_asserts = on;
    insert into auth.users(id) values ('${owner}');
    set local role service_role;
    do $$
    declare
      event_time timestamptz := clock_timestamp();
      period_start timestamptz := event_time - interval '30 days';
      payload jsonb;
      usage jsonb;
      reservation jsonb;
      first_id uuid := gen_random_uuid();
      second_id uuid;
      next_id uuid := gen_random_uuid();
      reservation_id uuid;
      attempts integer;
      i integer;
      subscription_status text;
    begin
      update public.global_usage set usage_date = (clock_timestamp() at time zone 'UTC')::date, used = 0
        where operation = 'generation';
      perform public.register_paddle_checkout('${canceledTransaction}', '${owner}');
      perform public.sync_paddle_event('transaction', jsonb_build_object('id', '${canceledTransaction}',
        'customer_id', '${customer}', 'subscription_id', '${canceled}', 'status', 'completed', 'updated_at', event_time), event_time);
      assert not (public.get_billing('${owner}')->>'paidAccess')::boolean, 'transaction delivery alone cannot grant access';
      assert (select subscription_id = '${canceled}' from public.paddle_transactions where id = '${canceledTransaction}'),
        'completed payments retain their subscription ID before its delivery';
      payload := jsonb_build_object('id', '${canceled}', 'customer_id', '${customer}', 'status', 'canceled',
        'plan', 'starter', 'period_start', period_start, 'period_end', period_start + interval '1 month',
        'updated_at', event_time + interval '1 minute');
      perform public.sync_paddle_event('subscription', payload, event_time + interval '1 minute');
      payload := payload || jsonb_build_object('status', 'active', 'transaction_id', '${canceledTransaction}', 'updated_at', event_time);
      perform public.sync_paddle_event('subscription', payload, event_time);
      perform public.sync_paddle_event('subscription', payload, event_time);
      assert (select status = 'canceled' and user_id = '${owner}' from public.paddle_subscriptions where id = '${canceled}'),
        'duplicate older creation deliveries cannot undo cancellation or ownership';

      perform public.register_paddle_checkout('${transaction}', '${owner}');
      payload := jsonb_build_object('id', '${subscription}', 'customer_id', '${customer}', 'transaction_id', '${transaction}',
        'status', 'trialing', 'plan', 'starter', 'period_start', period_start,
        'period_end', period_start + interval '1 month', 'updated_at', event_time);
      perform public.sync_paddle_event('subscription', payload, event_time);
      assert (public.get_billing('${owner}')->>'paidAccess')::boolean, 'trialing grants access';
      for i in 1..30 loop
        reservation_id := case when i = 1 then first_id else gen_random_uuid() end;
        if i = 2 then second_id := reservation_id; end if;
        reservation := public.reserve_usage('${owner}', 'generation', reservation_id, 0, '{}', '${globalLimits}');
        assert (reservation->>'allowed')::boolean, 'the monthly allowance must exceed five daily songs';
      end loop;
      reservation := public.reserve_usage('${owner}', 'generation', gen_random_uuid(), 0, '{}', '${globalLimits}');
      assert not (reservation->>'allowed')::boolean, 'the 31st song must be denied';
      assert not exists (select 1 from public.daily_usage where user_id = '${owner}' and operation = 'generation'),
        'paid songs do not consume the free counter';
      select used into attempts from public.global_usage where operation = 'generation';
      perform public.settle_generation('${owner}', first_id, 'failed');
      perform public.settle_generation('${owner}', first_id, 'failed');
      usage := public.get_usage('${owner}', '{}');
      assert (usage->'generation'->>'remaining')::integer = 1, 'a failure refunds exactly once';
      assert (select used = attempts from public.global_usage where operation = 'generation'), 'refunds retain global attempts';
      reservation := public.reserve_usage('${owner}', 'generation', gen_random_uuid(), 0, '{}', '${globalLimits}');
      assert (reservation->>'allowed')::boolean, 'one replacement fits';

      payload := payload || jsonb_build_object('status', 'active', 'period_start', period_start + interval '1 month',
        'period_end', period_start + interval '2 months', 'updated_at', event_time + interval '2 minutes');
      perform public.sync_paddle_event('subscription', payload, event_time + interval '2 minutes');
      usage := public.get_usage('${owner}', '{}');
      assert (usage->'generation'->>'remaining')::integer = 30, 'renewal starts a fresh allowance without rollover';
      reservation := public.reserve_usage('${owner}', 'generation', next_id, 0, '{}', '${globalLimits}');
      assert (reservation->>'allowed')::boolean;
      reservation := public.reserve_usage('${owner}', 'generation', next_id, 0, '{}', '${globalLimits}');
      assert not (reservation->>'created')::boolean, 'a request replay does not charge twice';
      perform public.settle_generation('${owner}', second_id, 'failed');
      perform public.settle_generation('${owner}', second_id, 'failed');
      usage := public.get_usage('${owner}', '{}');
      assert (usage->'generation'->>'used')::integer = 1, 'a late refund never changes the new period';
      update public.usage_reservations set created_at = event_time - interval '31 days'
        where user_id = '${owner}' and billing_period_start = period_start;
      perform public.cleanup_operations();
      assert (select count(*) = 31 from public.usage_reservations where user_id = '${owner}' and billing_period_start = period_start),
        'monthly reservations survive operation cleanup';

      payload := payload || jsonb_build_object('scheduled_change', jsonb_build_object('action', 'cancel',
        'effectiveAt', period_start + interval '2 months'), 'updated_at', event_time + interval '3 minutes');
      perform public.sync_paddle_event('subscription', payload, event_time + interval '3 minutes');
      assert (public.get_billing('${owner}')->>'paidAccess')::boolean, 'scheduled cancellation keeps active access';
      i := 4;
      foreach subscription_status in array array['paused', 'past_due', 'canceled'] loop
        payload := payload || jsonb_build_object('status', subscription_status, 'updated_at', event_time + i * interval '1 minute');
        perform public.sync_paddle_event('subscription', payload, event_time + i * interval '1 minute');
        assert not (public.get_billing('${owner}')->>'paidAccess')::boolean, 'inactive statuses stop paid access';
        usage := public.get_usage('${owner}', '{}');
        assert usage->>'plan' = 'free' and (usage->'generation'->>'limit')::integer = 5, 'inactive accounts use free allowances';
        i := i + 1;
      end loop;
    end;
    $$;
    rollback;`), '');
});

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
    query(`set role service_role; select public.reserve_usage('${user}', '${operation}', '${id}', ${bytes}, '{}', '${globalLimits}');`).then(JSON.parse);
  const usage = () => query(`set role service_role; select public.get_usage('${owner}', '{}');`).then(JSON.parse);
  const metadata = (id, bytes, user = owner) => ({ id, owner_id: user, title: 'untitled',
    object_key: `users/${user}/${id}.mp3`, prompt: 'offline folk', model: 'lyria-3.5', lyrics: '',
    size_bytes: bytes, status: 'pending', created_at: new Date().toISOString() });
  const save = (song) => query(`set role service_role; select public.prepare_song_save('${JSON.stringify(song)}', '{}');`).then(JSON.parse);

  await query(`insert into auth.users(id) values ('${owner}'), ('${other}');
    insert into public.user_quotas values ('${owner}', 3, 2, 3, 100), ('${other}', 3, 2, 3, 100);`);
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
      await assert.rejects(query(`set role ${role}; select public.reserve_usage('${owner}', 'chat', '${randomUUID()}', 0, '{}', '${globalLimits}');`), /permission denied/);
      await assert.rejects(query(`set role ${role}; select public.get_usage('${owner}', '{}');`), /permission denied/);
      await assert.rejects(query(`set role ${role}; select public.settle_generation('${owner}', '${song.id}', 'failed');`), /permission denied/);
      await assert.rejects(query(`set role ${role}; select public.prepare_song_save('${JSON.stringify(song)}', '{}');`), /permission denied/);
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
  const reserve = (operation) => query(`set role service_role; select public.reserve_usage('${owner}', '${operation}', '${randomUUID()}', ${operation === 'generation' ? 100 : 0}, '{}', '${globalLimits}');`).then(JSON.parse);
  const usage = () => query(`set role service_role; select public.get_usage('${owner}', '{}');`).then(JSON.parse);
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
    const save = () => query(`set role service_role; select public.prepare_song_save('${JSON.stringify(song)}', '{}');`).then(JSON.parse);
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
    const single = await query(`set role service_role; select public.reserve_usage('${other}', 'generation', '${randomUUID()}', 100, '{}', '${globalLimits}');`).then(JSON.parse);
    await settle(single.id, 'failed', other);
    await settle(single.id, 'failed', other);
    const empty = await query(`set role service_role; select public.get_usage('${other}', '{}');`).then(JSON.parse);
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
  const reserve = (user, operation, id = randomUUID(), bytes = 0, caps = limits) =>
    query(`set role service_role; select public.reserve_usage('${user}', '${operation}', '${id}', ${bytes}, '{}', '${caps}');`).then(JSON.parse);
  await query(`insert into auth.users(id) values ${users.map((id) => `('${id}')`).join(',')};
    insert into public.user_quotas values ${users.map((id) => `('${id}',100,100,100,0)`).join(',')};
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

test('operation records are server-only and bounded cleanup preserves unknown charges and active capacity', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a disposable, migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const unknown = randomUUID();
  const running = randomUUID();
  await query(`insert into auth.users(id) values ('${owner}');`);
  try {
    for (const id of [unknown, running]) {
      const reservation = await query(`set role service_role; select public.reserve_usage('${owner}', 'generation', '${id}', 100, '{}', '${globalLimits}');`).then(JSON.parse);
      assert.equal(reservation.allowed, true);
    }
    const before = await query(`set role service_role; select public.get_usage('${owner}', '{}');`).then(JSON.parse);
    const globalBefore = await query("select used from public.global_usage where operation = 'generation';");
    await query(`insert into public.operations(id, owner_id, kind, state, created_at) values
      ('${unknown}', '${owner}', 'music', 'unknown', now() - interval '8 days'),
      ('${running}', '${owner}', 'music', 'running', now() - interval '8 days');
      update public.usage_reservations set created_at = now() - interval '8 days' where user_id = '${owner}';`);
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        assert.equal(await query(`select has_table_privilege('${role}', 'public.operations', '${privilege}');`), 'f');
      }
      await assert.rejects(query(`set role ${role}; select * from public.operations;`), /permission denied/);
      await assert.rejects(query(`set role ${role}; select public.cleanup_operations();`), /permission denied/);
    }
    assert.equal(await query("select relrowsecurity from pg_class where oid = 'public.operations'::regclass;"), 't');
    await query('set role service_role; select public.cleanup_operations(); select public.cleanup_operations();');
    const after = await query(`set role service_role; select public.get_usage('${owner}', '{}');`).then(JSON.parse);
    assert.equal(after.generation.used, before.generation.used, 'unknown paid usage is never refunded by age');
    assert.equal(after.storage.reserved, 100, 'active work keeps its capacity; abandoned capacity is released');
    assert.equal(await query("select used from public.global_usage where operation = 'generation';"), globalBefore);
    assert.equal(await query(`select generation_status from public.usage_reservations where id = '${unknown}';`), 'reserved');
    assert.equal(await query(`select count(*) from public.operations where id = '${running}';`), '1');
    await query(`insert into public.operations(id, owner_id, kind, state, created_at)
      select gen_random_uuid(), '${owner}', 'chat', 'failed', now() - interval '8 days' from generate_series(1, 105);`);
    await query('set role service_role; select public.cleanup_operations();');
    assert.equal(await query(`select count(*) from public.operations where owner_id = '${owner}' and state = 'failed';`), '5', 'one pass deletes at most 100 records');
  } finally {
    await query(`delete from auth.users where id = '${owner}';`);
  }
});

test('plan edits update every allowance without resetting usage or granting customer writes', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const subscription = `sub_${owner.replaceAll('-', '').slice(0, 26)}`;
  const customer = `ctm_${owner.replaceAll('-', '').slice(0, 26)}`;
  assert.equal(await query(`begin;
    insert into auth.users(id) values ('${owner}');
    set local role service_role;
    do $$
    declare
      usage jsonb;
      result jsonb;
      limits public.plan_limits;
      operation text;
      song_id uuid := gen_random_uuid();
      song jsonb;
    begin
      assert jsonb_array_length(public.get_plan_limits()) = 4;
      usage := public.get_usage('${owner}', '{"chat_daily":99999}');
      assert (usage->'chat'->>'limit')::integer = 20, 'request defaults cannot override the plan';
      assert (usage->'generation'->>'limit')::integer = 5;
      insert into public.paddle_customers(id) values ('${customer}');
      insert into public.paddle_subscriptions(id, user_id, customer_id, status, plan, period_start, period_end, updated_at, occurred_at)
        values ('${subscription}', '${owner}', '${customer}', 'active', 'starter', now(), now() + interval '1 month', now(), now());
      for limits in select * from public.plan_limits where plan <> 'free' loop
        update public.paddle_subscriptions set plan = limits.plan,
          period_start = period_start + interval '1 month', period_end = period_end + interval '1 month' where id = '${subscription}';
        usage := public.get_usage('${owner}', '{}');
        assert usage->>'plan' = limits.plan;
        assert (usage->'chat'->>'limit')::integer = limits.chat_daily;
        assert (usage->'analysis'->>'limit')::integer = limits.analysis_daily;
        assert (usage->'generation'->>'limit')::integer = limits.songs_monthly;
        assert (usage->'storage'->>'limit')::bigint = limits.storage_bytes;
      end loop;
      update public.paddle_subscriptions set plan = 'starter',
        period_start = period_start + interval '1 month', period_end = period_end + interval '1 month' where id = '${subscription}';
      update public.global_usage set usage_date = current_date, used = 0;
      perform public.reserve_usage('${owner}', 'chat', gen_random_uuid(), 0, '{}', '${globalLimits}');
      perform public.reserve_usage('${owner}', 'analysis', gen_random_uuid(), 0, '{}', '${globalLimits}');
      perform public.reserve_usage('${owner}', 'generation', song_id, 10, '{}', '${globalLimits}');
      update public.plan_limits set chat_daily = 60, analysis_daily = 25, songs_monthly = 40, storage_bytes = 200 where plan = 'starter';
      usage := public.get_usage('${owner}', '{}');
      assert (usage->'chat'->>'limit')::integer = 60 and (usage->'chat'->>'used')::integer = 1;
      assert (usage->'analysis'->>'limit')::integer = 25 and (usage->'analysis'->>'used')::integer = 1;
      assert (usage->'generation'->>'remaining')::integer = 39;
      assert (usage->'storage'->>'remaining')::bigint = 190;
      update public.plan_limits set chat_daily = 1, analysis_daily = 1, songs_monthly = 1, storage_bytes = 5 where plan = 'starter';
      foreach operation in array array['chat', 'analysis', 'generation'] loop
        result := public.reserve_usage('${owner}', operation, gen_random_uuid(), 0, '{}', '${globalLimits}');
        assert not (result->>'allowed')::boolean, 'reductions retain used counts';
      end loop;
      song := jsonb_build_object('id', song_id, 'owner_id', '${owner}', 'object_key', 'users/${owner}/' || song_id || '.mp3',
        'prompt', 'offline folk', 'model', 'lyria-3.5', 'lyrics', '', 'size_bytes', 10, 'status', 'pending', 'created_at', now());
      assert not (public.prepare_song_save(song, '{}')->>'allowed')::boolean, 'saving uses current paid storage';
      update public.plan_limits set storage_bytes = 200 where plan = 'starter';
      assert (public.prepare_song_save(song, '{}')->>'allowed')::boolean, 'storage increases permit retry without generation';
      update public.plan_limits set songs_monthly = 0 where plan = 'starter';
      assert (public.get_billing('${owner}')->>'paidAccess')::boolean, 'zero songs does not revoke other paid benefits';
      update public.user_quotas set chat_daily = 0, generation_daily = 0 where user_id = '${owner}';
      usage := public.get_usage('${owner}', '{}');
      assert (usage->'chat'->>'limit')::integer = 0 and (usage->'generation'->>'limit')::integer = 0;
      update public.user_quotas set chat_daily = null, generation_daily = null where user_id = '${owner}';
      update public.paddle_subscriptions set status = 'canceled' where id = '${subscription}';
      usage := public.get_usage('${owner}', '{}');
      assert usage->>'plan' = 'free' and (usage->'chat'->>'limit')::integer = 20;
      assert (usage->'chat'->>'used')::integer = 1, 'downgrade preserves daily usage';
      assert (usage->'generation'->>'used')::integer = 0, 'paid songs stay in their billing period';
    end;
    $$;
    rollback;`), '');
  for (const role of ['anon', 'authenticated']) {
    for (const operation of ['select * from', 'update', 'delete from', 'insert into']) {
      const sql = operation === 'update' ? "update public.plan_limits set chat_daily = 99999" :
        operation === 'insert into' ? "insert into public.plan_limits values ('free',1,1,1,null,1)" : `${operation} public.plan_limits`;
      await assert.rejects(query(`set role ${role}; ${sql};`), /permission denied/);
    }
    await assert.rejects(query(`set role ${role}; select public.get_plan_limits();`), /permission denied/);
    await assert.rejects(query(`set role ${role}; select public.quota_account('${owner}', '{}', 'ultra');`), /permission denied/);
  }
});

test('concurrent paid songs cannot exceed an edited monthly allowance', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const customer = `ctm_${owner.replaceAll('-', '').slice(0, 26)}`;
  const subscription = `sub_${owner.replaceAll('-', '').slice(0, 26)}`;
  const original = await query("select songs_monthly from public.plan_limits where plan = 'starter';");
  await query(`insert into auth.users(id) values ('${owner}'); insert into public.paddle_customers(id) values ('${customer}');
    insert into public.paddle_subscriptions(id, user_id, customer_id, status, plan, period_start, period_end, updated_at, occurred_at)
      values ('${subscription}', '${owner}', '${customer}', 'active', 'starter', now(), now() + interval '1 month', now(), now());
    update public.plan_limits set songs_monthly = 2 where plan = 'starter';
    update public.global_usage set usage_date = (clock_timestamp() at time zone 'UTC')::date, used = 0 where operation = 'generation';`);
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      query(`set role service_role; select public.reserve_usage('${owner}', 'generation', '${randomUUID()}', 0, '{}', '${globalLimits}');`).then(JSON.parse)));
    assert.equal(results.filter(result => result.allowed).length, 2);
    assert.equal(await query(`select count(*) from public.usage_reservations where user_id = '${owner}' and billing_subscription_id = '${subscription}';`), '2');
  } finally {
    await query(`update public.plan_limits set songs_monthly = ${Number(original)} where plan = 'starter';
      delete from auth.users where id = '${owner}'; delete from public.paddle_subscriptions where id = '${subscription}';
      delete from public.paddle_customers where id = '${customer}';`);
  }
});

test('a subscription change during a reservation keeps the selected billing period', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const customer = `ctm_${owner.replaceAll('-', '').slice(0, 26)}`;
  const subscription = `sub_${owner.replaceAll('-', '').slice(0, 26)}`;
  const id = randomUUID();
  const lockTag = `plan-lock-${owner}`;
  const reserveTag = `plan-reserve-${owner}`;
  async function waitFor(sql) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await query(sql) === 't') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('the expected database lock was not observed');
  }
  await query(`insert into auth.users(id) values ('${owner}'); insert into public.paddle_customers(id) values ('${customer}');
    insert into public.paddle_subscriptions(id, user_id, customer_id, status, plan, period_start, period_end, updated_at, occurred_at)
      values ('${subscription}', '${owner}', '${customer}', 'active', 'starter', now(), now() + interval '1 month', now(), now());
    update public.global_usage set usage_date = (clock_timestamp() at time zone 'UTC')::date, used = 0 where operation = 'generation';`);
  const lock = query(`set application_name = '${lockTag}'; begin; select 1 from public.global_usage where operation = 'generation' for update; select pg_sleep(3); commit;`);
  let reservation;
  try {
    await waitFor(`select exists (select 1 from pg_stat_activity where application_name = '${lockTag}' and wait_event = 'PgSleep');`);
    reservation = query(`set application_name = '${reserveTag}'; set role service_role; select public.reserve_usage('${owner}', 'generation', '${id}', 0, '{}', '${globalLimits}');`).then(JSON.parse);
    await waitFor(`select exists (select 1 from pg_stat_activity where application_name = '${reserveTag}' and wait_event_type = 'Lock');`);
    await query(`update public.paddle_subscriptions set status = 'canceled' where id = '${subscription}';`);
    assert.equal((await reservation).allowed, true);
    assert.equal(await query(`select billing_subscription_id from public.usage_reservations where id = '${id}';`), subscription,
      'an in-flight request uses the plan and period selected together');
    assert.equal(await query(`select count(*) from public.daily_usage where user_id = '${owner}' and operation = 'generation';`), '0');
    const usage = JSON.parse(await query(`set role service_role; select public.get_usage('${owner}', '{}');`));
    assert.equal(usage.plan, 'free', 'the next request sees the cancellation');
    assert.equal(usage.generation.limit, 5);
  } finally {
    await Promise.allSettled([lock, reservation]);
    await query(`delete from auth.users where id = '${owner}'; delete from public.paddle_subscriptions where id = '${subscription}';
      delete from public.paddle_customers where id = '${customer}';`);
  }
});

test('lyrics reserve daily or monthly attempts independently from chat and preserve billing periods', {
  skip: databaseURL ? false : 'set QUOTA_TEST_DATABASE_URL to a migrated local PostgreSQL database',
}, async () => {
  const target = new URL(databaseURL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.match(target.pathname, /^\/quota_test/);
  const owner = randomUUID();
  const customer = `ctm_${owner.replaceAll('-', '').slice(0, 26)}`;
  const subscription = `sub_${owner.replaceAll('-', '').slice(0, 26)}`;
  const reserve = (id = randomUUID()) => query(`set role service_role; select public.reserve_lyrics('${owner}', '${id}');`).then(JSON.parse);
  const usage = () => query(`set role service_role; select public.get_usage('${owner}', '{}');`).then(JSON.parse);
  const original = await query("select lyrics_monthly from public.plan_limits where plan = 'starter';");
  await query(`insert into auth.users(id) values ('${owner}');`);
  try {
    const free = await Promise.all(Array.from({ length: 8 }, () => reserve()));
    assert.equal(free.filter(result => result.allowed).length, 1);
    assert.equal((await usage()).lyrics.remaining, 0);
    assert.equal((await reserve()).resource, 'lyrics');
    assert.equal((await usage()).chat.used, 0);
    await query(`insert into public.paddle_customers(id) values ('${customer}');
      insert into public.paddle_subscriptions(id, user_id, customer_id, status, plan, period_start, period_end, updated_at, occurred_at)
        values ('${subscription}', '${owner}', '${customer}', 'active', 'starter', now(), now() + interval '1 month', now(), now());
      update public.global_usage set usage_date = (clock_timestamp() at time zone 'UTC')::date, used = 0 where operation = 'chat';`);
    const paid = await Promise.all(Array.from({ length: 15 }, () => reserve()));
    assert.equal(paid.filter(result => result.allowed).length, 10, 'concurrent calls cannot exceed the billing allowance');
    const accepted = paid.find(result => result.allowed);
    assert.equal((await reserve(accepted.id)).created, false, 'replay does not charge twice');
    assert.deepEqual((await usage()).lyrics, { limit: 10, used: 10, remaining: 0 });
    const chat = JSON.parse(await query(`set role service_role; select public.reserve_usage('${owner}', 'chat', '${randomUUID()}', 0, '{}', '${globalLimits}');`));
    assert.equal(chat.allowed, true, 'exhausted lyrics do not block ordinary chat');
    await query("update public.plan_limits set lyrics_monthly = 11 where plan = 'starter';");
    assert.equal((await usage()).lyrics.remaining, 1, 'plan edits apply without resetting attempts');
    assert.equal((await reserve()).allowed, true);
    await query(`update public.usage_reservations set created_at = now() - interval '31 days' where user_id = '${owner}' and operation = 'lyrics';
      set role service_role; select public.cleanup_operations();`);
    assert.equal((await usage()).lyrics.used, 11, 'cleanup retains monthly paid attempts');
    await query(`update public.paddle_subscriptions set period_start = period_start + interval '1 month', period_end = period_end + interval '1 month' where id = '${subscription}';`);
    assert.equal((await usage()).lyrics.used, 0, 'renewal gets a new period without rollover');
    assert.equal((await reserve()).allowed, true);
    assert.equal((await usage()).lyrics.used, 1);
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(query(`set role ${role}; select public.reserve_lyrics('${owner}', '${randomUUID()}');`), /permission denied/);
    }
    await query(`update public.paddle_subscriptions set status = 'canceled' where id = '${subscription}';`);
    assert.equal((await usage()).lyrics.limit, 1, 'cancellation restores the free policy');
    assert.equal((await usage()).chat.used, 1, 'paid chat usage remains on its UTC day');
  } finally {
    await query(`update public.plan_limits set lyrics_monthly = ${Number(original)} where plan = 'starter';
      delete from auth.users where id = '${owner}'; delete from public.paddle_subscriptions where id = '${subscription}';
      delete from public.paddle_customers where id = '${customer}';`);
  }
});
