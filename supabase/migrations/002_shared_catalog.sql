-- Beta 2 is additive: v1 accounts and completed history are retained.
begin;
create table public.poca_catalog (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 60),
 event text not null check(length(event) between 1 and 60), kind text not null check(length(kind) between 1 and 30),
 member text not null check(length(member) between 1 and 30), img text not null,
 created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create unique index poca_catalog_identity on public.poca_catalog(public.poca_name(event),public.poca_name(kind),public.poca_name(member),public.poca_name(name));
create table public.poca2_members (
 id uuid primary key references auth.users(id), nickname text not null check(length(nickname) between 1 and 10),
 day date, give jsonb not null default '[]', want jsonb not null default '[]', revision bigint not null default 0
);
create unique index poca2_nickname on public.poca2_members(public.poca_name(nickname));
create index poca2_day on public.poca2_members(day);
create table public.poca2_trades (
 id uuid primary key default gen_random_uuid(), sender uuid not null references public.poca2_members(id),
 recipient uuid not null references public.poca2_members(id), status text not null check(status in ('pending','completed','cancelled')),
 payload jsonb not null, created_at timestamptz not null default now()
);
create index poca2_sender on public.poca2_trades(sender);
create index poca2_recipient on public.poca2_trades(recipient);
create table public.poca2_updates (scope text primary key, revision bigint not null default 0);
insert into public.poca2_updates values('catalog',0);
alter table public.poca_catalog enable row level security;
alter table public.poca2_members enable row level security;
alter table public.poca2_trades enable row level security;
alter table public.poca2_updates enable row level security;
revoke all on public.poca_catalog,public.poca2_members,public.poca2_trades,public.poca2_updates from anon,authenticated;
grant select on public.poca2_updates to authenticated;
create function public.poca2_day() returns date language sql stable security definer set search_path='' as $$ select day from public.poca2_members where id=auth.uid(); $$;
create policy poca2_updates_read on public.poca2_updates for select to authenticated using(scope='catalog' or scope=auth.uid()::text or scope=public.poca2_day()::text);
alter publication supabase_realtime add table public.poca2_updates;
insert into public.poca_catalog(id,name,event,kind,member,img)
 select ('10000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid,'포카 '||i,'기존 포카','포카','미분류','images/poca_0'||i||'.jpg' from generate_series(1,5) i;

create function public.poca2_cards(items jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare x jsonb; c public.poca_catalog; result jsonb := '[]'; q integer;
begin
 if items is null or jsonb_typeof(items)<>'array' then raise exception '포카를 선택해주세요.'; end if;
 if jsonb_array_length(items)>30 then raise exception '각각 30종까지 등록할 수 있어요.'; end if;
 if (select count(distinct v->>'id') from jsonb_array_elements(items) v)<>jsonb_array_length(items) then raise exception '같은 포카는 수량으로 등록해주세요.'; end if;
 for x in select * from jsonb_array_elements(items) loop
  if coalesce(x->>'qty','') !~ '^[0-9]{1,2}$' then raise exception '수량은 1~99장으로 입력해주세요.'; end if;
  q := (x->>'qty')::integer;
  if q<1 or q>99 then raise exception '수량은 1~99장으로 입력해주세요.'; end if;
  select * into c from public.poca_catalog where id::text=x->>'id';
  if c.id is null then raise exception '도감에 없는 포카예요. 다시 선택해주세요.'; end if;
  result := result || jsonb_build_array(jsonb_build_object('id',c.id,'name',c.name,'img',c.img,'event',c.event,'kind',c.kind,'member',c.member,'qty',q));
 end loop;
 return result;
end;
$$;
create function public.poca2_matches(who uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('peerId',p.id,'nickname',p.nickname,'give',g,'receive',r,'maxQty',least((g->>'qty')::int,(r->>'qty')::int,(pw->>'qty')::int,(mw->>'qty')::int))),'[]'::jsonb)
 from public.poca2_members me join public.poca2_members p on p.day=me.day and p.id<>me.id,
 lateral jsonb_array_elements(me.give) g, lateral jsonb_array_elements(p.give) r,
 lateral jsonb_array_elements(p.want) pw, lateral jsonb_array_elements(me.want) mw
 where me.id=who and pw->>'id'=g->>'id' and mw->>'id'=r->>'id' and g->>'id'<>r->>'id';
$$;
create function public.poca2_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare me public.poca2_members; history jsonb; old_history jsonb;
begin
 if auth.uid() is null then raise exception '로그인이 필요해요.'; end if;
 select * into me from public.poca2_members where id=auth.uid();
 select coalesce(jsonb_agg(payload||jsonb_build_object('id',id,'status',status) order by created_at desc),'[]') into history from public.poca2_trades where (sender=auth.uid() or recipient=auth.uid()) and status<>'cancelled';
 select coalesce(jsonb_agg(payload||jsonb_build_object('id',id,'status',status,'legacy',true) order by created_at desc),'[]') into old_history from public.poca_trades where (sender=auth.uid() or recipient=auth.uid()) and status='completed';
 return jsonb_build_object('me',case when me.id is null then null else to_jsonb(me) end,
 'catalog',(select coalesce(jsonb_agg(to_jsonb(c)-'created_by' order by c.created_at desc,c.id),'[]') from public.poca_catalog c),
 'count',(select count(*) from public.poca2_members where day=me.day),
 'matches',public.poca2_matches(auth.uid()),
 'listings',(select coalesce(jsonb_agg(to_jsonb(p)-'revision'-'day'),'[]') from public.poca2_members p where p.day=me.day and p.id<>auth.uid()),
 'trades',history||old_history);
end;
$$;
create function public.poca2_decrement(items jsonb, card_id text, amount integer) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(case when c->>'id'=card_id then jsonb_set(c,'{qty}',to_jsonb((c->>'qty')::int-amount)) else c end),'[]')
 from jsonb_array_elements(items) c where c->>'id'<>card_id or (c->>'qty')::int>amount;
$$;
create function public.poca2_action(action text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare me public.poca2_members; old_day date; chosen date; nick text; m jsonb; t public.poca2_trades; q integer; cid uuid; given jsonb; wanted jsonb; ev text; kd text; mem text; nm text; photo text;
begin
 if auth.uid() is null then raise exception '로그인이 필요해요.'; end if;
 perform pg_advisory_xact_lock(74109202);
 select * into me from public.poca2_members where id=auth.uid(); old_day:=me.day;
 if action='nickname' then
  nick:=trim(input->>'nickname');
  return jsonb_build_object('available',coalesce(length(nick) between 1 and 10,false) and not exists(select 1 from public.poca2_members where public.poca_name(nickname)=public.poca_name(nick) and id<>auth.uid()));
 elsif action='catalog_add' then
  ev:=trim(input->>'event'); kd:=trim(input->>'kind'); mem:=trim(input->>'member'); nm:=trim(input->>'name'); photo:=input->>'img';
  if coalesce(length(ev),0) not between 1 and 60 or coalesce(length(kd),0) not between 1 and 30 or coalesce(length(mem),0) not between 1 and 30 or coalesce(length(nm),0) not between 1 and 60 then raise exception '행사·종류·멤버·이름을 모두 입력해주세요.'; end if;
  if split_part(coalesce(photo,''),'/',1)<>auth.uid()::text or not exists(select 1 from storage.objects where bucket_id='poca-photos' and name=photo) then raise exception '본인 사진을 먼저 업로드해주세요.'; end if;
  if exists(select 1 from public.poca_catalog where public.poca_name(event)=public.poca_name(ev) and public.poca_name(kind)=public.poca_name(kd) and public.poca_name(member)=public.poca_name(mem) and public.poca_name(name)=public.poca_name(nm)) then raise exception '이미 도감에 있는 포카예요. 검색해서 선택해주세요.'; end if;
  insert into public.poca_catalog(name,event,kind,member,img,created_by) values(nm,ev,kd,mem,photo,auth.uid()) returning id into cid;
  update public.poca2_updates set revision=revision+1 where scope='catalog';
  return public.poca2_state()||jsonb_build_object('addedId',cid);
 elsif action='join' then
  nick:=trim(input->>'nickname');
  if coalesce(length(nick),0) not between 1 and 10 then raise exception '닉네임은 1~10자로 입력해주세요.'; end if;
  if exists(select 1 from public.poca2_members where public.poca_name(nickname)=public.poca_name(nick) and id<>auth.uid()) then raise exception '이미 사용 중인 닉네임이에요.'; end if;
  if coalesce(input->>'day','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '교환 날짜를 선택해주세요.'; end if;
  chosen:=(input->>'day')::date;
  if chosen<date '2020-01-01' or chosen>date '2100-12-31' then raise exception '교환 날짜를 확인해주세요.'; end if;
  if me.day is not null and me.day<>chosen then raise exception '현재 날짜에서 나간 뒤 다른 날짜로 참여해주세요.'; end if;
  insert into public.poca2_members(id,nickname,day) values(auth.uid(),nick,chosen) on conflict(id) do update set nickname=excluded.nickname,day=excluded.day,revision=poca2_members.revision+1;
  -- Retire only this user's old live listing; keep their completed v1 history.
  if exists(select 1 from public.poca_members where id=auth.uid() and room<>'') then perform public.poca_action('leave'); end if;
 elsif me.id is null then raise exception '날짜를 선택하고 먼저 참여해주세요.';
 elsif action='leave' then
  update public.poca2_members set day=null,give='[]',want='[]',revision=revision+1 where id=me.id;
  update public.poca2_trades set status='cancelled' where status='pending' and (sender=me.id or recipient=me.id);
 elsif action='publish' then
  if me.day is null then raise exception '교환 날짜에 먼저 참여해주세요.'; end if;
  if coalesce(input->>'revision','')<>me.revision::text then raise exception '다른 화면이나 거래에서 수량이 바뀌었어요. 최신 목록을 확인하고 다시 올려주세요.'; end if;
  given:=public.poca2_cards(input->'give'); wanted:=public.poca2_cards(input->'want');
  update public.poca2_members set give=given,want=wanted,revision=revision+1 where id=me.id;
  update public.poca2_trades set status='cancelled' where status='pending' and (sender=me.id or recipient=me.id);
 elsif action='request' then
  select x into m from jsonb_array_elements(public.poca2_matches(me.id)) x where x->>'peerId'=input->>'peerId' and x->'give'->>'id'=input->>'giveId' and x->'receive'->>'id'=input->>'receiveId' limit 1;
  if m is null then raise exception '매칭 목록이 바뀌었어요. 다시 확인해주세요.'; end if;
  if coalesce(input->>'quantity','') !~ '^[0-9]{1,2}$' then raise exception '교환 수량을 확인해주세요.'; end if;
  q:=(input->>'quantity')::int;
  if q<1 or q>(m->>'maxQty')::int then raise exception '교환 가능한 수량을 넘었어요.'; end if;
  if exists(select 1 from public.poca2_trades where status='pending' and (sender=me.id or recipient=me.id) and (sender::text=m->>'peerId' or recipient::text=m->>'peerId')) then raise exception '이미 완료 확인을 기다리는 거래가 있어요.'; end if;
  insert into public.poca2_trades(sender,recipient,status,payload) values(me.id,(m->>'peerId')::uuid,'pending',jsonb_build_object('from',me.id,'to',m->>'peerId','fromNick',me.nickname,'toNick',m->>'nickname','give',jsonb_set(m->'give','{qty}',to_jsonb(q)),'receive',jsonb_set(m->'receive','{qty}',to_jsonb(q)),'quantity',q,'room',me.day,'createdAt',now()));
 elsif action in ('confirm','cancel') then
  select * into t from public.poca2_trades where id::text=input->>'id' and status='pending' and (sender=me.id or recipient=me.id);
  if t.id is null then raise exception '진행 중인 거래가 없어요.'; end if;
  if action='cancel' then update public.poca2_trades set status='cancelled' where id=t.id;
  else
   if t.recipient<>me.id then raise exception '상대방이 완료를 확인해야 해요.'; end if;
   q:=(t.payload->>'quantity')::int;
   select x into m from jsonb_array_elements(public.poca2_matches(t.sender)) x where x->>'peerId'=me.id::text and x->'give'->>'id'=t.payload->'give'->>'id' and x->'receive'->>'id'=t.payload->'receive'->>'id';
   if m is null or (m->>'maxQty')::int<q then raise exception '목록이나 수량이 바뀌어 완료할 수 없어요.'; end if;
   update public.poca2_members set give=public.poca2_decrement(give,t.payload->'give'->>'id',q),want=public.poca2_decrement(want,t.payload->'receive'->>'id',q),revision=revision+1 where id=t.sender;
   update public.poca2_members set give=public.poca2_decrement(give,t.payload->'receive'->>'id',q),want=public.poca2_decrement(want,t.payload->'give'->>'id',q),revision=revision+1 where id=t.recipient;
   update public.poca2_trades set status='completed',payload=payload||jsonb_build_object('completedAt',now()) where id=t.id;
   update public.poca2_trades set status='cancelled' where status='pending' and (sender in (t.sender,t.recipient) or recipient in (t.sender,t.recipient));
   insert into public.poca2_updates(scope,revision) values(t.sender::text,1) on conflict(scope) do update set revision=poca2_updates.revision+1;
  end if;
 else raise exception '알 수 없는 요청입니다.';
 end if;
 insert into public.poca2_updates(scope,revision) select distinct s,1 from unnest(array[old_day::text,(select day::text from public.poca2_members where id=auth.uid()),auth.uid()::text]) s where s is not null on conflict(scope) do update set revision=poca2_updates.revision+1;
 return public.poca2_state();
end;
$$;
revoke all on function public.poca2_day(),public.poca2_cards(jsonb),public.poca2_matches(uuid),public.poca2_state(),public.poca2_decrement(jsonb,text,integer),public.poca2_action(text,jsonb) from public,anon,authenticated;
grant execute on function public.poca2_day(),public.poca2_state(),public.poca2_action(text,jsonb) to authenticated;
-- Catalog photos are shared with all signed-in catalog users, permanently.
create function public.poca2_catalog_photo(photo text) returns boolean language sql stable security definer set search_path='' as $$ select auth.uid() is not null and exists(select 1 from public.poca_catalog where img=photo); $$;
revoke all on function public.poca2_catalog_photo(text) from public,anon;
grant execute on function public.poca2_catalog_photo(text) to authenticated;
create policy poca2_catalog_photo_read on storage.objects for select to authenticated using(bucket_id='poca-photos' and public.poca2_catalog_photo(name));
commit;
