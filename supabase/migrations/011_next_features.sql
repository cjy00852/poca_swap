-- Additive catalog release, regional rooms, one-time extension and immediate completion.
begin;
alter table public.poca_catalog add column release text not null default '' check(length(release)<=60);
drop index public.poca_catalog_identity;
create unique index poca_catalog_identity on public.poca_catalog(public.poca_name(event),public.poca_name(release),public.poca_name(kind),public.poca_name(member),public.poca_name(name));
alter table public.poca2_members add column region text not null default '미지정';
create table public.poca_regions(name text not null check(length(name) between 1 and 40), key text primary key);
insert into public.poca_regions values('미지정',public.poca_name('미지정'));
alter table public.poca_regions enable row level security;
revoke all on public.poca_regions from public,anon,authenticated;
alter table public.poca2_trades add column extended boolean not null default false;
create or replace function public.poca_catalog_manage(operation text,input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare who uuid:=public.poca3_owner(); c public.poca_catalog; updated public.poca_catalog; ms text[]; p record; t record; photo text;
begin
 if who is null then raise exception '로그인 후 수정해주세요.'; end if;
 perform pg_advisory_xact_lock(74109202);
 select * into c from public.poca_catalog where id::text=input->>'id' for update;
 if c.id is null then raise exception '포카를 찾을 수 없어요.'; end if;
 if operation='restore' then
 if c.archived_at is null then return public.poca3_state(); end if;
 update public.poca_catalog set archived_at=null where id=c.id;
 elsif operation in ('edit','delete') then
 if c.archived_at is not null then raise exception '삭제된 포카예요.'; end if;
 if operation='delete' then update public.poca_catalog set archived_at=now() where id=c.id;
 else
 select array_agg(v order by n) into ms from unnest(array['원이','리브','미나미','메이','제나']) with ordinality u(v,n) where input->'members' ? v;
 if coalesce(cardinality(ms),0)=0 then raise exception '멤버를 선택해주세요.'; end if;
 if coalesce(length(trim(input->>'name')),0) not between 1 and 60 or coalesce(length(trim(input->>'event')),0) not between 1 and 60 or coalesce(length(trim(input->>'kind')),0) not between 1 and 30 then raise exception '이름·행사·종류를 확인해주세요.'; end if;
 if length(coalesce(input->>'release',''))>60 then raise exception '발매는 60자 이하로 입력해주세요.'; end if;
 photo:=input->>'img';
 if photo is distinct from c.img and (split_part(coalesce(photo,''),'/',1)<>auth.uid()::text or not exists(select 1 from storage.objects where bucket_id='poca-photos' and name=photo)) then raise exception '수정할 사진을 먼저 올려주세요.'; end if;
 update public.poca_catalog set name=trim(input->>'name'),event=trim(input->>'event'),release=coalesce(trim(input->>'release'),c.release),kind=trim(input->>'kind'),members=ms,member=case when cardinality(ms)=5 then '단체' else array_to_string(ms,' + ') end,img=photo where id=c.id;
 end if;
 select * into updated from public.poca_catalog where id=c.id;
 for p in select * from public.poca2_members where give @> jsonb_build_array(jsonb_build_object('id',c.id)) or want @> jsonb_build_array(jsonb_build_object('id',c.id)) or conditions::text like '%'||c.id::text||'%' loop
 update public.poca2_members set
 give=(select coalesce(jsonb_agg(case when x->>'id'=c.id::text then x||jsonb_build_object('name',updated.name,'img',updated.img,'event',updated.event,'release',updated.release,'kind',updated.kind,'member',updated.member) else x end),'[]') from jsonb_array_elements(give) x where operation<>'delete' or x->>'id'<>c.id::text),
 want=(select coalesce(jsonb_agg(case when x->>'id'=c.id::text then x||jsonb_build_object('name',updated.name,'img',updated.img,'event',updated.event,'release',updated.release,'kind',updated.kind,'member',updated.member) else x end),'[]') from jsonb_array_elements(want) x where operation<>'delete' or x->>'id'<>c.id::text),
 conditions=case when operation='delete' then coalesce((select jsonb_object_agg(k,jsonb_set(v,'{ids}',coalesce((select jsonb_agg(val) from jsonb_array_elements(v->'ids') val where val#>>'{}'<>c.id::text),'[]'))) from jsonb_each(conditions) r(k,v) where k<>c.id::text),'{}') else conditions end,revision=revision+1 where id=p.id;
 perform public.poca3_notify(p.id);
 end loop;
 for t in update public.poca2_trades set status='cancelled' where status in ('awaiting','reserved','pending') and (payload->'give'->>'id'=c.id::text or payload->'receive'->>'id'=c.id::text) returning * loop
 perform public.poca3_notify(t.sender);perform public.poca3_notify(t.recipient);
 end loop;
 else raise exception '알 수 없는 요청이에요.';
 end if;
 insert into public.poca_catalog_changes(card_id,actor,operation,before_data) values(c.id,who,operation,to_jsonb(c));
 update public.poca2_updates set revision=revision+1 where scope='catalog';
 return public.poca3_state();
end $$;
create or replace function public.poca2_cards(items jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare x jsonb; c public.poca_catalog; result jsonb := '[]'; q integer;
begin
 if items is null or jsonb_typeof(items)<>'array' then raise exception '포카를 선택해주세요.'; end if;
 if jsonb_array_length(items)>30 then raise exception '각각 30종까지 등록할 수 있어요.'; end if;
 if (select count(distinct v->>'id') from jsonb_array_elements(items) v)<>jsonb_array_length(items) then raise exception '같은 포카는 수량으로 등록해주세요.'; end if;
 for x in select * from jsonb_array_elements(items) loop
  if coalesce(x->>'qty','') !~ '^[0-9]{1,2}$' then raise exception '수량은 1~99장으로 입력해주세요.'; end if;
  q := (x->>'qty')::integer;
  if q<1 or q>99 then raise exception '수량은 1~99장으로 입력해주세요.'; end if;
  select * into c from public.poca_catalog where id::text=x->>'id' and archived_at is null;
  if c.id is null then raise exception '도감에 없는 포카예요. 다시 선택해주세요.'; end if;
  result := result || jsonb_build_array(jsonb_build_object('id',c.id,'name',c.name,'img',c.img,'event',c.event,'release',c.release,'kind',c.kind,'member',c.member,'qty',q));
 end loop;
 return result;
end;
$$;
create or replace function public.poca3_matches(who uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('peerId',p.id,'nickname',p.nickname,'exchangeNo',p.exchange_no,'give',g,'receive',r,'maxQty',1,'mutual',public.poca3_accepts(me.conditions->(g->>'id'),(r->>'id')::uuid) and public.poca3_accepts(p.conditions->(r->>'id'),(g->>'id')::uuid)) order by (public.poca3_accepts(me.conditions->(g->>'id'),(r->>'id')::uuid) and public.poca3_accepts(p.conditions->(r->>'id'),(g->>'id')::uuid)) desc,p.exchange_no),'[]')
 from public.poca2_members me join public.poca2_members p on p.day=me.day and p.region=me.region and p.id<>me.id,
 lateral jsonb_array_elements(me.give) g,lateral jsonb_array_elements(p.give) r
 where me.id=who and g->>'id'<>r->>'id' and public.poca3_available(me.id,g->>'id')>0 and public.poca3_available(p.id,r->>'id')>0
 and (public.poca3_accepts(me.conditions->(g->>'id'),(r->>'id')::uuid) or public.poca3_accepts(p.conditions->(r->>'id'),(g->>'id')::uuid));
$$;
create or replace function public.poca3_state() returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); who uuid:=public.poca3_owner(); result jsonb;
begin
 if device is null then raise exception '로그인이 필요해요.'; end if;
 perform pg_advisory_xact_lock(74109202);perform public.poca3_expire();
 if who is null then
 return jsonb_build_object('me',null,'account',null,'admin',false,'catalog',(select coalesce(jsonb_agg(to_jsonb(c)-'created_by' order by created_at desc),'[]') from public.poca_catalog c where c.archived_at is null),'matches','[]'::jsonb,'listings','[]'::jsonb,'trades','[]'::jsonb,'count',0,'regions',(select jsonb_agg(name order by name) from public.poca_regions));
 end if;
 perform set_config('request.jwt.claim.sub',who::text,true);
 result:=public.poca2_state();
 perform set_config('request.jwt.claim.sub',device::text,true);
 return result||jsonb_build_object('account',jsonb_build_object('id',who,'nickname',(select nickname from public.poca3_accounts where owner=who)), 'regions',(select jsonb_agg(name order by name) from public.poca_regions),'count',(select count(*) from public.poca2_members where day=(select day from public.poca2_members where id=who) and region=(select region from public.poca2_members where id=who)), 'admin',exists(select 1 from public.poca3_admins where owner=who),'matches',public.poca3_matches(who),
 'listings',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'nickname',p.nickname,'exchangeNo',p.exchange_no,'want',p.want,'give',(select coalesce(jsonb_agg(g||jsonb_build_object('available',public.poca3_available(p.id,g->>'id'))),'[]') from jsonb_array_elements(p.give) g))),'[]') from public.poca2_members p where p.id<>who and p.day=(select day from public.poca2_members where id=who) and p.region=(select region from public.poca2_members where id=who)),
 'trades',(select coalesce(jsonb_agg(payload||jsonb_build_object('id',id,'status',status,'expiresAt',expires_at,'extended',extended) order by created_at desc),'[]') from public.poca2_trades where (sender=who or recipient=who) and status<>'cancelled') || coalesce((select jsonb_agg(t) from jsonb_array_elements(result->'trades') t where t->>'legacy'='true'),'[]'));
end $$;
create or replace function public.poca3_action(action text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); who uuid:=public.poca3_owner(); me public.poca2_members; t public.poca2_trades; m jsonb; g jsonb; rule jsonb; cond jsonb:='{}'; chosen_members text[]; cid uuid; peer uuid; chosen_region text;
begin
 if who is null then raise exception '닉네임과 PIN으로 로그인해주세요.'; end if;
 perform pg_advisory_xact_lock(74109202);perform public.poca3_expire();
 select * into me from public.poca2_members where id=who;
 if action='logout' then delete from public.poca3_sessions where poca3_sessions.device=auth.uid(); return public.poca3_state();
 elsif action='catalog_add' then
 select array_agg(v order by ord) into chosen_members from unnest(array['원이','리브','미나미','메이','제나']) with ordinality u(v,ord) where input->'members' ? v;
 if coalesce(cardinality(chosen_members),0)=0 then raise exception '멤버 또는 단체를 선택해주세요.'; end if;
 if coalesce(length(trim(input->>'event')),0) not between 1 and 60 or coalesce(length(trim(input->>'kind')),0) not between 1 and 30 or coalesce(length(trim(input->>'name')),0) not between 1 and 60 or length(coalesce(input->>'release',''))>60 then raise exception '이름·행사·발매·종류를 확인해주세요.'; end if;
 if split_part(coalesce(input->>'img',''),'/',1)<>device::text or not exists(select 1 from storage.objects where bucket_id='poca-photos' and name=input->>'img') then raise exception '본인 사진을 먼저 업로드해주세요.'; end if;
 insert into public.poca_catalog(name,event,release,kind,member,members,img,created_by) values(trim(input->>'name'),trim(input->>'event'),coalesce(trim(input->>'release'),''),trim(input->>'kind'),case when cardinality(chosen_members)=5 then '단체' else array_to_string(chosen_members,' + ') end,chosen_members,input->>'img',device);
 update public.poca2_updates set revision=revision+1 where scope='catalog';
 return public.poca3_state();
 elsif action in ('join','leave','publish') then
 if action='join' then
 chosen_region:=trim(coalesce(input->>'region','미지정'));
 if length(chosen_region) not between 1 and 40 or public.poca_name(chosen_region)='' then raise exception '지역을 1~40자로 입력해주세요.'; end if;
 insert into public.poca_regions(name,key) values(chosen_region,public.poca_name(chosen_region)) on conflict do nothing;
 select name into chosen_region from public.poca_regions where key=public.poca_name(chosen_region);
 if me.day is not null and me.region<>chosen_region then raise exception '현재 교환방에서 나간 뒤 다른 지역으로 참여해주세요.'; end if;
 end if;
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
 if action='join' then update public.poca2_members set region=chosen_region where id=who; end if;
 if action='publish' then update public.poca2_members set conditions=cond where id=who; end if;
 elsif action='request' then
 select v into m from jsonb_array_elements(public.poca3_matches(who)) v where v->>'peerId'=input->>'peerId' and v->'give'->>'id'=input->>'giveId' and v->'receive'->>'id'=input->>'receiveId';
 if m is null then raise exception '매칭 목록이 바뀌었어요. 다시 확인해주세요.'; end if;
 peer:=(m->>'peerId')::uuid;
 insert into public.poca2_trades(sender,recipient,status,expires_at,payload) values(who,peer,'awaiting',now()+interval '15 minutes',jsonb_build_object('from',who,'to',peer,'fromNick',me.nickname,'toNick',m->>'nickname','fromNo',me.exchange_no,'toNo',m->'exchangeNo','give',jsonb_set(m->'give','{qty}','1'),'receive',jsonb_set(m->'receive','{qty}','1'),'quantity',1,'room',me.day,'region',me.region,'createdAt',now()));
 elsif action in ('accept','complete','confirm','cancel','extend') then
 select * into t from public.poca2_trades where id::text=input->>'id' and (sender=who or recipient=who) and status in ('awaiting','reserved','pending') and expires_at>now();
 if t.id is null then raise exception '종료되거나 만료된 약속이에요.'; end if;
 if action='cancel' then update public.poca2_trades set status='cancelled' where id=t.id;
 elsif action='accept' and t.status='awaiting' and t.recipient=who then update public.poca2_trades set status='reserved' where id=t.id;
 elsif action='extend' and t.status in ('reserved','pending') and not t.extended then
 update public.poca2_trades set expires_at=expires_at+interval '15 minutes',extended=true where id=t.id;
 elsif (action='complete' and t.status='reserved') or (action='confirm' and t.status='pending' and coalesce(t.payload->>'completionBy',t.sender::text)<>who::text) then
 if not exists(select 1 from public.poca2_members a join public.poca2_members b on a.day=b.day and a.region=b.region where a.id=t.sender and b.id=t.recipient and a.day is not null) then raise exception '참여 날짜·지역이 바뀌었어요.'; end if;
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
commit;

