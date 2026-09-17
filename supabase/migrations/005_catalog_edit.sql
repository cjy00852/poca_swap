-- Shared catalog corrections; deletion is reversible through catalog_restore.
begin;
alter table public.poca_catalog add column archived_at timestamptz;
create table public.poca_catalog_changes(id bigint generated always as identity primary key,card_id uuid not null,actor uuid not null,operation text not null,before_data jsonb not null,created_at timestamptz not null default now());
alter table public.poca_catalog_changes enable row level security;
revoke all on public.poca_catalog_changes from public,anon,authenticated;
create function public.poca_catalog_manage(operation text,input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 photo:=input->>'img';
 if photo is distinct from c.img and (split_part(coalesce(photo,''),'/',1)<>auth.uid()::text or not exists(select 1 from storage.objects where bucket_id='poca-photos' and name=photo)) then raise exception '수정할 사진을 먼저 올려주세요.'; end if;
 update public.poca_catalog set name=trim(input->>'name'),event=trim(input->>'event'),kind=trim(input->>'kind'),members=ms,member=case when cardinality(ms)=5 then '단체' else array_to_string(ms,' + ') end,img=photo where id=c.id;
 end if;
 select * into updated from public.poca_catalog where id=c.id;
 for p in select * from public.poca2_members where give @> jsonb_build_array(jsonb_build_object('id',c.id)) or want @> jsonb_build_array(jsonb_build_object('id',c.id)) or conditions::text like '%'||c.id::text||'%' loop
 update public.poca2_members set
 give=(select coalesce(jsonb_agg(case when x->>'id'=c.id::text then x||jsonb_build_object('name',updated.name,'img',updated.img,'event',updated.event,'kind',updated.kind,'member',updated.member) else x end),'[]') from jsonb_array_elements(give) x where operation<>'delete' or x->>'id'<>c.id::text),
 want=(select coalesce(jsonb_agg(case when x->>'id'=c.id::text then x||jsonb_build_object('name',updated.name,'img',updated.img,'event',updated.event,'kind',updated.kind,'member',updated.member) else x end),'[]') from jsonb_array_elements(want) x where operation<>'delete' or x->>'id'<>c.id::text),
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
revoke all on function public.poca_catalog_manage(text,jsonb) from public,anon,authenticated;
grant execute on function public.poca_catalog_manage(text,jsonb) to authenticated;
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
  result := result || jsonb_build_array(jsonb_build_object('id',c.id,'name',c.name,'img',c.img,'event',c.event,'kind',c.kind,'member',c.member,'qty',q));
 end loop;
 return result;
end;
$$;
create or replace function public.poca2_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare me public.poca2_members; history jsonb; old_history jsonb;
begin
 if auth.uid() is null then raise exception '로그인이 필요해요.'; end if;
 select * into me from public.poca2_members where id=auth.uid();
 select coalesce(jsonb_agg(payload||jsonb_build_object('id',id,'status',status) order by created_at desc),'[]') into history from public.poca2_trades where (sender=auth.uid() or recipient=auth.uid()) and status<>'cancelled';
 select coalesce(jsonb_agg(payload||jsonb_build_object('id',id,'status',status,'legacy',true) order by created_at desc),'[]') into old_history from public.poca_trades where (sender=auth.uid() or recipient=auth.uid()) and status='completed';
 return jsonb_build_object('me',case when me.id is null then null else to_jsonb(me) end,
 'catalog',(select coalesce(jsonb_agg(to_jsonb(c)-'created_by' order by c.created_at desc,c.id),'[]') from public.poca_catalog c where c.archived_at is null),
 'count',(select count(*) from public.poca2_members where day=me.day),
 'matches',public.poca2_matches(auth.uid()),
 'listings',(select coalesce(jsonb_agg(to_jsonb(p)-'revision'-'day'),'[]') from public.poca2_members p where p.day=me.day and p.id<>auth.uid()),
 'trades',history||old_history);
end;
$$;
create or replace function public.poca3_state() returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); who uuid:=public.poca3_owner(); result jsonb;
begin
 if device is null then raise exception '로그인이 필요해요.'; end if;
 perform pg_advisory_xact_lock(74109202);perform public.poca3_expire();
 if who is null then
 return jsonb_build_object('me',null,'account',null,'admin',false,'catalog',(select coalesce(jsonb_agg(to_jsonb(c)-'created_by' order by created_at desc),'[]') from public.poca_catalog c where c.archived_at is null),'matches','[]'::jsonb,'listings','[]'::jsonb,'trades','[]'::jsonb,'count',0);
 end if;
 perform set_config('request.jwt.claim.sub',who::text,true);
 result:=public.poca2_state();
 perform set_config('request.jwt.claim.sub',device::text,true);
 return result||jsonb_build_object('account',jsonb_build_object('id',who,'nickname',(select nickname from public.poca3_accounts where owner=who)), 'admin',exists(select 1 from public.poca3_admins where owner=who),'matches',public.poca3_matches(who),
 'listings',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'nickname',p.nickname,'exchangeNo',p.exchange_no,'want',p.want,'give',(select coalesce(jsonb_agg(g||jsonb_build_object('available',public.poca3_available(p.id,g->>'id'))),'[]') from jsonb_array_elements(p.give) g))),'[]') from public.poca2_members p where p.id<>who and p.day=(select day from public.poca2_members where id=who)),
 'trades',(select coalesce(jsonb_agg(payload||jsonb_build_object('id',id,'status',status,'expiresAt',expires_at) order by created_at desc),'[]') from public.poca2_trades where (sender=who or recipient=who) and status<>'cancelled') || coalesce((select jsonb_agg(t) from jsonb_array_elements(result->'trades') t where t->>'legacy'='true'),'[]'));
end $$;
commit;
