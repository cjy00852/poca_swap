begin;
create function public.poca_admin_participants() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.poca3_is_admin() then raise exception '관리자만 참여자 목록을 확인할 수 있어요.'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('nickname',nickname,'day',day,'region',region,'exchangeNo',exchange_no) order by day desc,region,exchange_no),'[]') from public.poca2_members where day is not null);
end $$;
revoke all on function public.poca_admin_participants() from public,anon,authenticated;
grant execute on function public.poca_admin_participants() to authenticated;
commit;
