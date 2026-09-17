-- User clarification: every PIN-authenticated member may contribute to the shared catalog.
begin;
create or replace function public.poca3_action(action text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); who uuid:=public.poca3_owner(); me public.poca2_members; t public.poca2_trades; m jsonb; g jsonb; rule jsonb; cond jsonb:='{}'; chosen_members text[]; cid uuid; peer uuid; name text;
begin
 if who is null then raise exception '닉네임과 PIN으로 로그인해주세요.'; end if;
 perform pg_advisory_xact_lock(74109202);perform public.poca3_expire();
 select * into me from public.poca2_members where id=who;
 if action='logout' then delete from public.poca3_sessions where poca3_sessions.device=auth.uid(); return public.poca3_state();
 elsif action='catalog_add' then
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
drop policy poca3_admin_upload on storage.objects;
create policy poca3_member_upload on storage.objects for insert to authenticated with check(bucket_id='poca-photos' and (storage.foldername(name))[1]=auth.uid()::text and public.poca3_owner() is not null);
commit;
