begin;
create table public.poca_presence(device uuid not null references auth.users(id) on delete cascade,tab uuid not null,last_seen timestamptz not null default now(),primary key(device,tab));
create index poca_presence_recent on public.poca_presence(last_seen);
alter table public.poca_presence enable row level security;
revoke all on public.poca_presence from public,anon,authenticated;
create function public.poca_presence_ping(tab_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or tab_id is null then raise exception '연결 후 다시 시도해주세요.'; end if;
 insert into public.poca_presence(device,tab,last_seen) values(auth.uid(),tab_id,now()) on conflict(device,tab) do update set last_seen=excluded.last_seen;
 delete from public.poca_presence where last_seen<now()-interval '1 day';
 with active as (
 select distinct coalesce('owner:'||s.owner::text,'device:'||p.device::text) as identity,a.nickname
 from public.poca_presence p left join public.poca3_sessions s on s.device=p.device and s.expires_at>now() left join public.poca3_accounts a on a.owner=s.owner
 where p.last_seen>now()-interval '75 seconds'
 ) select jsonb_build_object('count',count(*),'visitors',count(*) filter(where nickname is null),'members',case when public.poca3_is_admin() then coalesce(jsonb_agg(nickname order by nickname) filter(where nickname is not null),'[]') else '[]'::jsonb end) into result from active;
 return result;
end $$;
revoke all on function public.poca_presence_ping(uuid) from public,anon,authenticated;
grant execute on function public.poca_presence_ping(uuid) to authenticated;
commit;
