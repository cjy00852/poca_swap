begin;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.poca3_login(text,text,boolean)'::regprocedure) into definition;
 if position('30 days' in definition)=0 then raise exception 'Expected session duration missing'; end if;
 execute replace(definition,'30 days','1 hour');
 select pg_get_functiondef('public.poca3_state()'::regprocedure) into definition;
 execute replace(definition,'''account'',jsonb_build_object','''sessionExpiresAt'',(select expires_at from public.poca3_sessions where poca3_sessions.device=auth.uid()),''account'',jsonb_build_object');
end $migration$;
update public.poca3_sessions set expires_at=least(expires_at,now()+interval '1 hour');
create or replace function public.poca_admin_participants() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.poca3_is_admin() then raise exception '관리자만 로그인 목록을 확인할 수 있어요.'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(p) order by p.nickname),'[]') from (
 select a.owner as id,a.nickname,count(*) as devices,max(s.expires_at) as "expiresAt"
 from public.poca3_sessions s join public.poca3_accounts a on a.owner=s.owner
 where s.expires_at>now() group by a.owner,a.nickname
 ) p);
end $$;
create function public.poca_admin_logout(target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(74109202);
 if not public.poca3_is_admin() then raise exception '관리자만 강제 로그아웃할 수 있어요.'; end if;
 if target=public.poca3_owner() then raise exception '내 계정은 상단 로그아웃을 이용해주세요.'; end if;
 delete from public.poca3_sessions where owner=target;
 perform public.poca3_notify(target);
 return public.poca_admin_participants();
end $$;
revoke all on function public.poca_admin_logout(uuid) from public,anon,authenticated;
grant execute on function public.poca_admin_logout(uuid) to authenticated;
commit;
