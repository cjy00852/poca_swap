-- Run once in the Supabase SQL Editor. All mutations go through atomic RPCs.
create table public.poca_members (
 id uuid primary key references auth.users(id) on delete cascade,
 nickname text not null check (length(nickname) between 1 and 10),
 room text not null default '', give jsonb not null default '[]', want jsonb not null default '[]'
);
create index poca_members_room on public.poca_members(room);
create table public.poca_trades (
 id uuid primary key default gen_random_uuid(),
 sender uuid not null references public.poca_members(id), recipient uuid not null references public.poca_members(id),
 status text not null check (status in ('pending','completed')), payload jsonb not null,
 created_at timestamptz not null default now()
);
create index poca_trades_sender on public.poca_trades(sender);
create index poca_trades_recipient on public.poca_trades(recipient);
create table public.poca_rooms (room text primary key, revision bigint not null default 0);

alter table public.poca_members enable row level security;
alter table public.poca_trades enable row level security;
alter table public.poca_rooms enable row level security;
revoke all on public.poca_members, public.poca_trades, public.poca_rooms from anon, authenticated;
grant select on public.poca_rooms to authenticated;

create function public.poca_my_room() returns text language sql stable security definer set search_path = '' as $$
 select room from public.poca_members where id = auth.uid();
$$;
create policy room_updates on public.poca_rooms for select to authenticated using (room = public.poca_my_room() and room <> '');

create function public.poca_name(value text) returns text language sql immutable set search_path = '' as $$
 select lower(regexp_replace(normalize(value, NFKC), '[[:space:]]+', '', 'g'));
$$;
create function public.poca_matches(who uuid) returns jsonb language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('peerId', p.id, 'nickname', p.nickname, 'give', g, 'receive', r)), '[]'::jsonb)
 from public.poca_members me join public.poca_members p on p.room = me.room and p.id <> me.id,
 lateral jsonb_array_elements(me.give) g, lateral jsonb_array_elements(p.give) r
 where me.id = who and me.room <> ''
 and exists (select 1 from jsonb_array_elements(p.want) w where public.poca_name(w->>'name') = public.poca_name(g->>'name'))
 and exists (select 1 from jsonb_array_elements(me.want) w where public.poca_name(w->>'name') = public.poca_name(r->>'name'));
$$;
create function public.poca_state() returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.poca_members; result jsonb;
begin
 if auth.uid() is null then raise exception '로그인이 필요해요.'; end if;
 select * into me from public.poca_members where id = auth.uid();
 if me.id is null then return jsonb_build_object('me',null,'count',0,'matches','[]'::jsonb,'listings','[]'::jsonb,'trades','[]'::jsonb); end if;
 select jsonb_build_object(
 'me', to_jsonb(me),
 'count', (select count(*) from public.poca_members where room = me.room and room <> ''),
 'matches', public.poca_matches(me.id),
 'listings', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'nickname',nickname,'give',give,'want',want)), '[]'::jsonb) from public.poca_members where room = me.room and room <> '' and id <> me.id),
 'trades', (select coalesce(jsonb_agg(payload || jsonb_build_object('id',id,'status',status) order by created_at desc), '[]'::jsonb) from public.poca_trades where sender = me.id or recipient = me.id)
 ) into result;
 return result;
end;
$$;
create function public.poca_validate_cards(items jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare c jsonb;
begin
 if items is null or jsonb_typeof(items) <> 'array' then raise exception '포카 목록을 확인해주세요.'; end if;
 if jsonb_array_length(items) > 30 then raise exception '각각 최대 30장까지 등록할 수 있어요.'; end if;
 if (select count(distinct x->>'id') from jsonb_array_elements(items) x) <> jsonb_array_length(items) then raise exception '중복된 포카입니다.'; end if;
 for c in select * from jsonb_array_elements(items) loop
  if coalesce(length(c->>'id'),0) not between 1 and 80 or coalesce(length(trim(c->>'name')),0) not between 1 and 40 then raise exception '포카 이름을 확인해주세요.'; end if;
  if exists(select 1 from public.poca_trades t where t.status = 'completed' and ((t.sender = auth.uid() and t.payload->'give'->>'id' = c->>'id') or (t.recipient = auth.uid() and t.payload->'receive'->>'id' = c->>'id'))) then raise exception '이미 교환한 포카가 포함되어 있어요. 목록을 새로고침해주세요.'; end if;
  if coalesce(c->>'img','') !~ '^images/poca_0[1-5]\.jpg$' then
   if split_part(coalesce(c->>'img',''), '/', 1) <> auth.uid()::text or not exists (select 1 from storage.objects where bucket_id = 'poca-photos' and name = c->>'img') then raise exception '사진을 먼저 업로드해주세요.'; end if;
  end if;
 end loop;
end;
$$;
create function public.poca_action(action text, input jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.poca_members; other public.poca_members; t public.poca_trades; m jsonb; old_room text; new_room text; new_nick text; tid uuid;
begin
 if auth.uid() is null then raise exception '로그인이 필요해요.'; end if;
 -- Keep validation and both users' card removal in one transaction, including concurrent requests.
 perform pg_advisory_xact_lock(74109201);
 select * into me from public.poca_members where id = auth.uid();
 old_room := me.room;
 if action = 'join' then
  new_room := upper(normalize(trim(input->>'room'), NFKC)); new_nick := trim(input->>'nickname');
  if coalesce(length(new_room),0) not between 1 and 30 or coalesce(length(new_nick),0) not between 1 and 10 then raise exception '닉네임과 현장 코드를 확인해주세요.'; end if;
  if me.room <> '' and me.room <> new_room then raise exception '현재 현장에서 먼저 나가주세요.'; end if;
  insert into public.poca_members(id,nickname,room) values(auth.uid(),new_nick,new_room)
  on conflict(id) do update set nickname = excluded.nickname, room = excluded.room;
 elsif me.id is null then raise exception '현장에 먼저 입장해주세요.';
 elsif action = 'leave' then
  update public.poca_members set room = '', give = '[]', want = '[]' where id = me.id;
  delete from public.poca_trades where status = 'pending' and (sender = me.id or recipient = me.id);
 elsif action = 'publish' then
  if me.room = '' then raise exception '현장에 먼저 입장해주세요.'; end if;
  perform public.poca_validate_cards(input->'give'); perform public.poca_validate_cards(input->'want');
  update public.poca_members set give = input->'give', want = input->'want' where id = me.id;
  delete from public.poca_trades where status = 'pending' and (sender = me.id or recipient = me.id);
 elsif action = 'request' then
  select x into m from jsonb_array_elements(public.poca_matches(me.id)) x where x->>'peerId' = input->>'peerId' and x->'give'->>'id' = input->>'giveId' and x->'receive'->>'id' = input->>'receiveId' limit 1;
  if m is null then raise exception '목록이 바뀌었어요. 매칭을 다시 확인해주세요.'; end if;
  if exists(select 1 from public.poca_trades where status = 'pending' and (sender = me.id or recipient = me.id) and (sender::text = input->>'peerId' or recipient::text = input->>'peerId')) then raise exception '이미 확인을 기다리는 거래가 있어요.'; end if;
  insert into public.poca_trades(sender,recipient,status,payload) values(me.id,(m->>'peerId')::uuid,'pending',jsonb_build_object('from',me.id,'to',m->>'peerId','fromNick',me.nickname,'toNick',m->>'nickname','give',m->'give','receive',m->'receive','room',me.room,'createdAt',now()));
 elsif action in ('confirm','cancel') then
  select * into t from public.poca_trades where id = (input->>'id')::uuid and status = 'pending' and (sender = me.id or recipient = me.id);
  if t.id is null then raise exception '진행 중인 거래가 없어요.'; end if;
  if action = 'cancel' then delete from public.poca_trades where id = t.id;
  else
   if t.recipient <> me.id then raise exception '상대방이 완료를 확인해야 해요.'; end if;
   select * into other from public.poca_members where id = t.sender;
   if not exists (select 1 from jsonb_array_elements(public.poca_matches(other.id)) x where x->>'peerId' = me.id::text and x->'give'->>'id' = t.payload->'give'->>'id' and x->'receive'->>'id' = t.payload->'receive'->>'id') then raise exception '목록이 바뀌어 완료할 수 없어요.'; end if;
   update public.poca_members set
    give = (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(give) c where c->>'id' <> t.payload->'give'->>'id'),
    want = (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(want) with ordinality a(c,n) where n <> coalesce((select min(n2) from jsonb_array_elements(want) with ordinality b(c2,n2) where public.poca_name(c2->>'name') = public.poca_name(t.payload->'receive'->>'name')),0))
   where id = other.id;
   update public.poca_members set
    give = (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(give) c where c->>'id' <> t.payload->'receive'->>'id'),
    want = (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(want) with ordinality a(c,n) where n <> coalesce((select min(n2) from jsonb_array_elements(want) with ordinality b(c2,n2) where public.poca_name(c2->>'name') = public.poca_name(t.payload->'give'->>'name')),0))
   where id = me.id;
   update public.poca_trades set status = 'completed', payload = payload || jsonb_build_object('completedAt',now()) where id = t.id;
   delete from public.poca_trades where status = 'pending' and (sender in (me.id, other.id) or recipient in (me.id, other.id));
  end if;
 else raise exception '알 수 없는 요청입니다.';
 end if;
 select room into new_room from public.poca_members where id = auth.uid();
 insert into public.poca_rooms(room,revision) select distinct r,1 from unnest(array[old_room,new_room]) r where r is not null and r <> ''
 on conflict(room) do update set revision = public.poca_rooms.revision + 1;
 return public.poca_state();
end;
$$;

-- Only these RPCs are callable by signed-in users; helper functions are private.
revoke all on function public.poca_my_room(), public.poca_name(text), public.poca_matches(uuid), public.poca_state(), public.poca_validate_cards(jsonb), public.poca_action(text,jsonb) from public, anon, authenticated;
grant execute on function public.poca_my_room(), public.poca_state(), public.poca_action(text,jsonb) to authenticated;
alter publication supabase_realtime add table public.poca_rooms;

-- Private photos: owner, same-venue participants and the two trade participants can read.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('poca-photos','poca-photos',false,500000,array['image/jpeg']);
create function public.poca_can_read_photo(photo text) returns boolean language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null and (
 split_part(photo,'/',1) = auth.uid()::text
 or exists(select 1 from public.poca_members p, lateral jsonb_array_elements(p.give || p.want) c where p.room <> '' and p.room = public.poca_my_room() and c->>'img' = photo)
 or exists(select 1 from public.poca_trades t where (t.sender = auth.uid() or t.recipient = auth.uid()) and (t.payload->'give'->>'img' = photo or t.payload->'receive'->>'img' = photo)));
$$;
revoke all on function public.poca_can_read_photo(text) from public, anon;
grant execute on function public.poca_can_read_photo(text) to authenticated;
create policy poca_photo_read on storage.objects for select to authenticated using(bucket_id = 'poca-photos' and public.poca_can_read_photo(name));
create policy poca_photo_upload on storage.objects for insert to authenticated with check(bucket_id = 'poca-photos' and (storage.foldername(name))[1] = auth.uid()::text);
