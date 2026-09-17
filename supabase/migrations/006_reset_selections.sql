begin;
create function public.poca_reset_selections(selection text,expected_revision bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare who uuid:=public.poca3_owner(); me public.poca2_members; t record;
begin
 if who is null then raise exception '로그인 후 초기화해주세요.'; end if;
 if selection not in ('give','want') or selection is null then raise exception '초기화할 목록을 확인해주세요.'; end if;
 perform pg_advisory_xact_lock(74109202);
 select * into me from public.poca2_members where id=who for update;
 if me.id is null then return public.poca3_state(); end if;
 if expected_revision is distinct from me.revision then raise exception '다른 화면에서 목록이 바뀌었어요. 최신 목록에서 다시 시도해주세요.'; end if;
 update public.poca2_members set give=case when selection='give' then '[]'::jsonb else give end,want='[]',conditions='{}',revision=revision+1 where id=who;
 for t in update public.poca2_trades set status='cancelled' where status in ('awaiting','reserved','pending') and (sender=who or recipient=who) returning sender,recipient loop
 perform public.poca3_notify(t.sender);perform public.poca3_notify(t.recipient);
 end loop;
 perform public.poca3_notify(who);
 return public.poca3_state();
end $$;
revoke all on function public.poca_reset_selections(text,bigint) from public,anon,authenticated;
grant execute on function public.poca_reset_selections(text,bigint) to authenticated;
commit;
