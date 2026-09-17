begin;
create table public.poca_chats(id uuid primary key default gen_random_uuid(),a uuid not null references public.poca3_accounts(owner),b uuid not null references public.poca3_accounts(owner),a_card uuid not null,b_card uuid not null,context jsonb not null,a_read bigint not null default 0,b_read bigint not null default 0,created_at timestamptz not null default now(),check(a<b),unique(a,b,a_card,b_card));
create table public.poca_messages(seq bigint generated always as identity primary key,id uuid not null unique,chat uuid not null references public.poca_chats,sender uuid not null references public.poca3_accounts(owner),body text not null check(length(body) between 1 and 1000),created_at timestamptz not null default now());
create index poca_messages_room on public.poca_messages(chat,seq);
alter table public.poca_chats enable row level security;
alter table public.poca_messages enable row level security;
revoke all on public.poca_chats,public.poca_messages from public,anon,authenticated;
create function public.poca_chat(action text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare who uuid:=public.poca3_owner(); room public.poca_chats; peer uuid; g uuid; r uuid; left_id uuid; right_id uuid; msg public.poca_messages; rows jsonb; boundary bigint; me public.poca2_members; other public.poca2_members;
begin
 if who is null then raise exception '로그인 후 채팅해주세요.'; end if;
 perform pg_advisory_xact_lock(74109202);
 if action='list' then
 return jsonb_build_object('rooms',(select coalesce(jsonb_agg(x order by x->>'updatedAt' desc),'[]') from (
 select jsonb_build_object('id',c.id,'peerId',case when c.a=who then c.b else c.a end,'nickname',p.nickname,'number',p.exchange_no,'context',c.context,'amA',c.a=who,
 'unread',(select count(*) from public.poca_messages m where m.chat=c.id and m.sender<>who and m.seq>case when c.a=who then c.a_read else c.b_read end),
 'last',(select body from public.poca_messages m where m.chat=c.id order by seq desc limit 1),'updatedAt',coalesce((select max(created_at) from public.poca_messages m where m.chat=c.id),c.created_at)) x
 from public.poca_chats c join public.poca2_members p on p.id=case when c.a=who then c.b else c.a end where who in(c.a,c.b)) q));
 elsif action='open' then
 peer:=(input->>'peerId')::uuid;g:=(input->>'giveId')::uuid;r:=(input->>'receiveId')::uuid;
 select * into room from public.poca_chats where a=least(who,peer) and b=greatest(who,peer) and a_card=case when who<peer then g else r end and b_card=case when who<peer then r else g end;
 if room.id is null then
 if not exists(select 1 from jsonb_array_elements(public.poca3_matches(who)) m where m->>'peerId'=peer::text and m->'give'->>'id'=g::text and m->'receive'->>'id'=r::text) and not exists(select 1 from public.poca2_trades t where t.status in ('awaiting','reserved','pending') and t.expires_at>now() and ((sender=who and recipient=peer and payload->'give'->>'id'=g::text and payload->'receive'->>'id'=r::text) or (recipient=who and sender=peer and payload->'receive'->>'id'=g::text and payload->'give'->>'id'=r::text))) then raise exception '현재 교환 후보나 약속에서 채팅을 시작해주세요.'; end if;
 insert into public.poca_chats(a,b,a_card,b_card,context) values(least(who,peer),greatest(who,peer),case when who<peer then g else r end,case when who<peer then r else g end,jsonb_build_object('aCard',(select to_jsonb(c)-'created_by' from public.poca_catalog c where c.id=case when who<peer then g else r end),'bCard',(select to_jsonb(c)-'created_by' from public.poca_catalog c where c.id=case when who<peer then r else g end))) returning * into room;
 insert into public.poca2_updates(scope,revision) values(peer::text,1) on conflict(scope) do update set revision=poca2_updates.revision+1;
 end if;
 return jsonb_build_object('id',room.id);
 end if;
 select * into room from public.poca_chats where id::text=input->>'id' and who in(a,b) for update;
 if room.id is null then raise exception '대화에 접근할 수 없어요.'; end if;
 if action='messages' then
 boundary:=coalesce((input->>'before')::bigint,9223372036854775807);
 select coalesce(jsonb_agg(to_jsonb(m) order by m.seq),'[]') into rows from (select seq,id,sender,body,created_at from public.poca_messages where chat=room.id and seq<boundary order by seq desc limit 100) m;
 return jsonb_build_object('messages',rows,'hasOlder',exists(select 1 from public.poca_messages where chat=room.id and seq<(select min((v->>'seq')::bigint) from jsonb_array_elements(rows) v)));
 elsif action='send' then
 select * into msg from public.poca_messages where id=(input->>'messageId')::uuid;
 if msg.id is not null then
 if msg.chat<>room.id or msg.sender<>who or msg.body<>trim(input->>'body') then raise exception '메시지 요청이 일치하지 않아요.'; end if;
 return jsonb_build_object('sent',true);
 end if;
 if coalesce(length(trim(input->>'body')),0) not between 1 and 1000 then raise exception '메시지는 1~1000자로 입력해주세요.'; end if;
 if (select count(*) from public.poca_messages where sender=who and created_at>now()-interval '1 minute')>=30 then raise exception '메시지가 너무 빨라요. 잠시 후 다시 보내주세요.'; end if;
 insert into public.poca_messages(id,chat,sender,body) values((input->>'messageId')::uuid,room.id,who,trim(input->>'body'));
 insert into public.poca2_updates(scope,revision) values(room.a::text,1),(room.b::text,1) on conflict(scope) do update set revision=poca2_updates.revision+1;
 return jsonb_build_object('sent',true);
 elsif action='read' then
 boundary:=coalesce((input->>'through')::bigint,0);
 if boundary>coalesce((select max(seq) from public.poca_messages where chat=room.id),0) then raise exception '읽은 메시지를 다시 확인해주세요.'; end if;
 update public.poca_chats set a_read=case when a=who then greatest(a_read,boundary) else a_read end,b_read=case when b=who then greatest(b_read,boundary) else b_read end where id=room.id;
 return jsonb_build_object('read',true);
 else raise exception '알 수 없는 요청이에요.';
 end if;
end $$;
revoke all on function public.poca_chat(text,jsonb) from public,anon,authenticated;
grant execute on function public.poca_chat(text,jsonb) to authenticated;
create function public.poca_chat_photo(photo text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.poca_chats where public.poca3_owner() in(a,b) and (context->'aCard'->>'img'=photo or context->'bCard'->>'img'=photo));
$$;
revoke all on function public.poca_chat_photo(text) from public,anon,authenticated;
grant execute on function public.poca_chat_photo(text) to authenticated;
create policy poca_chat_photo_read on storage.objects for select to authenticated using(bucket_id='poca-photos' and public.poca_chat_photo(name));
commit;
