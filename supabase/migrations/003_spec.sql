-- Apply after 002 only during the separately requested integration/deployment stage.
begin;
create extension if not exists pgcrypto with schema extensions;
create table public.poca3_accounts(owner uuid primary key references auth.users, nickname text not null, pin_hash text not null);
create unique index poca3_account_name on public.poca3_accounts(public.poca_name(nickname));
create table public.poca3_sessions(device uuid primary key references auth.users, owner uuid not null references public.poca3_accounts, expires_at timestamptz not null);
create table public.poca3_login_limits(key text primary key, failures int not null default 0, blocked_until timestamptz);
create table public.poca3_admins(owner uuid primary key references auth.users);
alter table public.poca3_accounts enable row level security;
alter table public.poca3_sessions enable row level security;
alter table public.poca3_login_limits enable row level security;
alter table public.poca3_admins enable row level security;
revoke all on public.poca3_accounts,public.poca3_sessions,public.poca3_login_limits,public.poca3_admins from public,anon,authenticated;
alter table public.poca_catalog add column members text[] not null default '{}';
update public.poca_catalog c set members=case when member='단체' then array['원이','리브','미나미','메이','제나'] else array(select m from unnest(array['원이','리브','미나미','메이','제나']) with ordinality u(m,n) where m=any(regexp_split_to_array(c.member,'[ +＋,·/]+')) order by n) end;
alter table public.poca2_members add column exchange_no bigint generated always as identity;
alter table public.poca2_members add column conditions jsonb not null default '{}';
-- Preserve previous global wanted cards as explicit per-offer candidates.
update public.poca2_members p set conditions=coalesce((select jsonb_object_agg(g->>'id',jsonb_build_object('ids',(select coalesce(jsonb_agg(w->>'id'),'[]') from jsonb_array_elements(p.want) w),'members','[]'::jsonb,'any',false)) from jsonb_array_elements(p.give) g),'{}');
alter table public.poca2_trades drop constraint poca2_trades_status_check;
alter table public.poca2_trades add constraint poca2_trades_status_check check(status in ('awaiting','reserved','pending','completed','cancelled'));
alter table public.poca2_trades add column expires_at timestamptz;
-- Previous multi-card pending requests must be recreated under the one-card protocol.
update public.poca2_trades set status='cancelled' where status='pending';
create function public.poca3_owner() returns uuid language sql stable security definer set search_path='' as $$ select owner from public.poca3_sessions where device=auth.uid() and expires_at>now() $$;
create function public.poca3_notify(who uuid) returns void language sql security definer set search_path='' as $$
 insert into public.poca2_updates(scope,revision) select distinct s,1 from unnest(array[who::text,(select day::text from public.poca2_members where id=who)]) s where s is not null on conflict(scope) do update set revision=poca2_updates.revision+1;
$$;
create function public.poca3_expire() returns void language plpgsql security definer set search_path='' as $$
declare t record;
begin
 for t in update public.poca2_trades set status='cancelled' where status in ('awaiting','reserved','pending') and expires_at<=now() returning sender,recipient loop
 perform public.poca3_notify(t.sender);perform public.poca3_notify(t.recipient);
 end loop;
end $$;
create function public.poca3_available(who uuid,card text) returns int language sql stable security definer set search_path='' as $$
 select greatest(0,coalesce((select (g->>'qty')::int from public.poca2_members p,lateral jsonb_array_elements(p.give) g where p.id=who and g->>'id'=card),0)-(select count(*)::int from public.poca2_trades t where status in ('awaiting','reserved','pending') and expires_at>now() and ((sender=who and payload->'give'->>'id'=card) or (recipient=who and payload->'receive'->>'id'=card))));
$$;
create function public.poca3_accepts(rule jsonb, card uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((rule->>'any')::boolean,false) or coalesce(rule->'ids' ? card::text,false) or exists(select 1 from public.poca_catalog c, unnest(c.members) m where c.id=card and rule->'members' ? m);
$$;
create function public.poca3_matches(who uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('peerId',p.id,'nickname',p.nickname,'exchangeNo',p.exchange_no,'give',g,'receive',r,'maxQty',1,'mutual',public.poca3_accepts(me.conditions->(g->>'id'),(r->>'id')::uuid) and public.poca3_accepts(p.conditions->(r->>'id'),(g->>'id')::uuid)) order by (public.poca3_accepts(me.conditions->(g->>'id'),(r->>'id')::uuid) and public.poca3_accepts(p.conditions->(r->>'id'),(g->>'id')::uuid)) desc,p.exchange_no),'[]')
 from public.poca2_members me join public.poca2_members p on p.day=me.day and p.id<>me.id,
 lateral jsonb_array_elements(me.give) g,lateral jsonb_array_elements(p.give) r
 where me.id=who and g->>'id'<>r->>'id' and public.poca3_available(me.id,g->>'id')>0 and public.poca3_available(p.id,r->>'id')>0
 and (public.poca3_accepts(me.conditions->(g->>'id'),(r->>'id')::uuid) or public.poca3_accepts(p.conditions->(r->>'id'),(g->>'id')::uuid));
$$;
create function public.poca3_state() returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); who uuid:=public.poca3_owner(); result jsonb;
begin
 if device is null then raise exception '로그인이 필요해요.'; end if;
 perform pg_advisory_xact_lock(74109202);perform public.poca3_expire();
 if who is null then
 return jsonb_build_object('me',null,'account',null,'admin',false,'catalog',(select coalesce(jsonb_agg(to_jsonb(c)-'created_by' order by created_at desc),'[]') from public.poca_catalog c),'matches','[]'::jsonb,'listings','[]'::jsonb,'trades','[]'::jsonb,'count',0);
 end if;
 perform set_config('request.jwt.claim.sub',who::text,true);
 result:=public.poca2_state();
 perform set_config('request.jwt.claim.sub',device::text,true);
 return result||jsonb_build_object('account',jsonb_build_object('id',who,'nickname',(select nickname from public.poca3_accounts where owner=who)), 'admin',exists(select 1 from public.poca3_admins where owner=who),'matches',public.poca3_matches(who),
 'listings',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'nickname',p.nickname,'exchangeNo',p.exchange_no,'want',p.want,'give',(select coalesce(jsonb_agg(g||jsonb_build_object('available',public.poca3_available(p.id,g->>'id'))),'[]') from jsonb_array_elements(p.give) g))),'[]') from public.poca2_members p where p.id<>who and p.day=(select day from public.poca2_members where id=who)),
 'trades',(select coalesce(jsonb_agg(payload||jsonb_build_object('id',id,'status',status,'expiresAt',expires_at) order by created_at desc),'[]') from public.poca2_trades where (sender=who or recipient=who) and status<>'cancelled') || coalesce((select jsonb_agg(t) from jsonb_array_elements(result->'trades') t where t->>'legacy'='true'),'[]'));
end $$;
create function public.poca3_login(nickname text,pin text,register boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); a public.poca3_accounts; k text:=public.poca_name(trim(nickname)); n text:=trim(nickname); lockrow public.poca3_login_limits;
begin
 if device is null then raise exception '연결 후 다시 시도해주세요.'; end if;
 if length(n) not between 1 and 10 or coalesce(pin,'') !~ '^[0-9]{4}$' then return jsonb_build_object('error','닉네임 1~10자와 숫자 4자리 PIN을 입력해주세요.'); end if;
 perform pg_advisory_xact_lock(74109202);
 insert into public.poca3_login_limits(key) values(k),('device:'||device) on conflict do nothing;
 if exists(select 1 from public.poca3_login_limits where key in (k,'device:'||device) and blocked_until>now()) then return jsonb_build_object('error','시도가 많아요. 15분 후 다시 시도해주세요.'); end if;
 select * into a from public.poca3_accounts where public.poca_name(poca3_accounts.nickname)=k;
 if register then
 if a.owner is not null or exists(select 1 from public.poca2_members where public.poca_name(poca2_members.nickname)=k and id<>device) or exists(select 1 from public.poca3_accounts where owner=device) then return jsonb_build_object('error','이미 등록된 닉네임 또는 계정이에요. 로그인해주세요.'); end if;
 insert into public.poca3_accounts values(device,n,extensions.crypt(pin,extensions.gen_salt('bf',10))) returning * into a;
 else
 if a.owner is null or a.pin_hash<>extensions.crypt(pin,a.pin_hash) then
 update public.poca3_login_limits set failures=case when blocked_until<=now() then 1 else failures+1 end,blocked_until=case when blocked_until<=now() then null when failures>=4 then now()+interval '15 minutes' else blocked_until end where key in (k,'device:'||device);
 return jsonb_build_object('error','닉네임 또는 PIN이 맞지 않아요.');
 end if;
 end if;
 update public.poca3_login_limits set failures=0,blocked_until=null where key in (k,'device:'||device);
 insert into public.poca3_sessions values(device,a.owner,now()+interval '30 days') on conflict on constraint poca3_sessions_pkey do update set owner=excluded.owner,expires_at=excluded.expires_at;
 return public.poca3_state();
end $$;
create function public.poca3_action(action text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); who uuid:=public.poca3_owner(); me public.poca2_members; t public.poca2_trades; m jsonb; g jsonb; rule jsonb; cond jsonb:='{}'; chosen_members text[]; cid uuid; peer uuid; name text;
begin
 if who is null then raise exception '닉네임과 PIN으로 로그인해주세요.'; end if;
 perform pg_advisory_xact_lock(74109202);perform public.poca3_expire();
 select * into me from public.poca2_members where id=who;
 if action='logout' then delete from public.poca3_sessions where poca3_sessions.device=auth.uid(); return public.poca3_state();
 elsif action='catalog_add' then
 if not exists(select 1 from public.poca3_admins where owner=who) then raise exception '도감은 관리자만 등록할 수 있어요.'; end if;
 select array_agg(v order by ord) into chosen_members from unnest(array['원이','리브','미나미','메이','제나']) with ordinality u(v,ord) where input->'members' ? v;
 if coalesce(cardinality(chosen_members),0)=0 then raise exception '멤버 또는 단체를 선택해주세요.'; end if;
 -- Upload belongs to the current device session, not the recovered account UUID.
 m:=public.poca2_action('catalog_add',input||jsonb_build_object('member',case when cardinality(chosen_members)=5 then '단체' else array_to_string(chosen_members,' + ') end));
 cid:=(m->>'addedId')::uuid;
 update public.poca_catalog set members=chosen_members where id=cid;
 return public.poca3_state();
 elsif action in ('join','leave','publish') then
 if action in ('leave','publish') then
 for t in update public.poca2_trades set status='cancelled' where status in ('awaiting','reserved','pending') and (sender=who or recipient=who) returning * loop
 perform public.poca3_notify(t.sender);perform public.poca3_notify(t.recipient);
 end loop;
 end if;
 if action='publish' then
 for g in select * from jsonb_array_elements(public.poca2_cards(input->'give')) loop
 rule:=input->'conditions'->(g->>'id');
 if rule is null or jsonb_typeof(rule->'ids') is distinct from 'array' or jsonb_typeof(rule->'members') is distinct from 'array' or jsonb_typeof(rule->'any') is distinct from 'boolean' then raise exception '각 보유 포카의 교환 후보를 선택해주세요.'; end if;
 if jsonb_array_length(rule->'ids')>500 or exists(select 1 from jsonb_array_elements_text(rule->'ids') candidate(card_id) where not exists(select 1 from public.poca_catalog c where c.id::text=candidate.card_id)) or exists(select 1 from jsonb_array_elements_text(rule->'members') v where v not in ('원이','리브','미나미','메이','제나')) then raise exception '교환 후보를 다시 선택해주세요.'; end if;
 if not (rule->>'any')::boolean and jsonb_array_length(rule->'ids')=0 and jsonb_array_length(rule->'members')=0 then raise exception '각 보유 포카의 교환 후보를 선택해주세요.'; end if;
 cond:=cond||jsonb_build_object(g->>'id',rule);
 end loop;
 end if;
 perform set_config('request.jwt.claim.sub',who::text,true);
 perform public.poca2_action(action,input||case when action='join' then jsonb_build_object('nickname',(select nickname from public.poca3_accounts where owner=who)) when action='publish' then jsonb_build_object('want','[]'::jsonb) else '{}'::jsonb end);
 perform set_config('request.jwt.claim.sub',device::text,true);
 if action='publish' then update public.poca2_members set conditions=cond where id=who; end if;
 elsif action='request' then
 select v into m from jsonb_array_elements(public.poca3_matches(who)) v where v->>'peerId'=input->>'peerId' and v->'give'->>'id'=input->>'giveId' and v->'receive'->>'id'=input->>'receiveId';
 if m is null then raise exception '매칭 목록이 바뀌었어요. 다시 확인해주세요.'; end if;
 peer:=(m->>'peerId')::uuid;
 insert into public.poca2_trades(sender,recipient,status,expires_at,payload) values(who,peer,'awaiting',now()+interval '15 minutes',jsonb_build_object('from',who,'to',peer,'fromNick',me.nickname,'toNick',m->>'nickname','fromNo',me.exchange_no,'toNo',m->'exchangeNo','give',jsonb_set(m->'give','{qty}','1'),'receive',jsonb_set(m->'receive','{qty}','1'),'quantity',1,'room',me.day,'createdAt',now()));
 elsif action in ('accept','complete','confirm','cancel') then
 select * into t from public.poca2_trades where id::text=input->>'id' and (sender=who or recipient=who) and status in ('awaiting','reserved','pending') and expires_at>now();
 if t.id is null then raise exception '종료되거나 만료된 약속이에요.'; end if;
 if action='cancel' then update public.poca2_trades set status='cancelled' where id=t.id;
 elsif action='accept' and t.status='awaiting' and t.recipient=who then update public.poca2_trades set status='reserved' where id=t.id;
 elsif action='complete' and t.status='reserved' then update public.poca2_trades set status='pending',payload=payload||jsonb_build_object('completionBy',who) where id=t.id;
 elsif action='confirm' and t.status='pending' and coalesce(t.payload->>'completionBy',t.sender::text)<>who::text then
 if not exists(select 1 from public.poca2_members a join public.poca2_members b on a.day=b.day where a.id=t.sender and b.id=t.recipient and a.day is not null) then raise exception '참여 날짜가 바뀌었어요.'; end if;
 if not exists(select 1 from public.poca2_members p,lateral jsonb_array_elements(p.give) c where p.id=t.sender and c->>'id'=t.payload->'give'->>'id' and (c->>'qty')::int>=1) or not exists(select 1 from public.poca2_members p,lateral jsonb_array_elements(p.give) c where p.id=t.recipient and c->>'id'=t.payload->'receive'->>'id' and (c->>'qty')::int>=1) then raise exception '보유수량이 바뀌었어요.'; end if;
 update public.poca2_members set give=public.poca2_decrement(give,t.payload->'give'->>'id',1),revision=revision+1 where id=t.sender;
 update public.poca2_members set give=public.poca2_decrement(give,t.payload->'receive'->>'id',1),revision=revision+1 where id=t.recipient;
 update public.poca2_trades set status='completed',payload=payload||jsonb_build_object('completedAt',now()) where id=t.id;
 else raise exception '상대방 확인 또는 현재 약속 상태를 확인해주세요.';
 end if;
 perform public.poca3_notify(t.sender);perform public.poca3_notify(t.recipient);
 else raise exception '알 수 없는 요청이에요.';
 end if;
 perform public.poca3_notify(who);if peer is not null then perform public.poca3_notify(peer);end if;
 return public.poca3_state();
end $$;
create function public.poca3_is_admin() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.poca3_admins where owner=public.poca3_owner()) $$;
revoke all on function public.poca3_is_admin() from public,anon,authenticated;
grant execute on function public.poca3_is_admin() to authenticated;
drop policy poca_photo_upload on storage.objects;
create policy poca3_admin_upload on storage.objects for insert to authenticated with check(bucket_id='poca-photos' and (storage.foldername(name))[1]=auth.uid()::text and public.poca3_is_admin());
create function public.poca3_history_photo(photo text) returns boolean language sql stable security definer set search_path='' as $$
 select public.poca3_owner() is not null and (split_part(photo,'/',1)=public.poca3_owner()::text or exists(select 1 from public.poca_trades where (sender=public.poca3_owner() or recipient=public.poca3_owner()) and (payload->'give'->>'img'=photo or payload->'receive'->>'img'=photo)));
$$;
revoke all on function public.poca3_history_photo(text) from public,anon,authenticated;
grant execute on function public.poca3_history_photo(text) to authenticated;
create policy poca3_history_photo_read on storage.objects for select to authenticated using(bucket_id='poca-photos' and public.poca3_history_photo(name));
-- Device sessions receive the recovered owner's updates without exposing account/PIN tables.
create function public.poca3_day() returns date language sql stable security definer set search_path='' as $$ select day from public.poca2_members where id=public.poca3_owner() $$;
drop policy poca2_updates_read on public.poca2_updates;
create policy poca3_updates_read on public.poca2_updates for select to authenticated using(scope='catalog' or scope=public.poca3_owner()::text or scope=(select public.poca3_day())::text);
revoke all on function public.poca3_owner(),public.poca3_day(),public.poca3_notify(uuid),public.poca3_expire(),public.poca3_available(uuid,text),public.poca3_accepts(jsonb,uuid),public.poca3_matches(uuid),public.poca3_state(),public.poca3_login(text,text,boolean),public.poca3_action(text,jsonb) from public,anon,authenticated;
grant execute on function public.poca3_owner(),public.poca3_day(),public.poca3_state(),public.poca3_login(text,text,boolean),public.poca3_action(text,jsonb) to authenticated;
revoke execute on function public.poca_action(text,jsonb),public.poca_state(),public.poca2_action(text,jsonb),public.poca2_state() from public,anon,authenticated;
commit;


