-- Keep PIN attempt protection; report the actual remaining wait.
begin;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.poca3_login(text,text,boolean)'::regprocedure) into definition;
 if position($old$'시도가 많아요. 15분 후 다시 시도해주세요.'$old$ in definition)=0 then raise exception 'Expected login limit message missing'; end if;
 execute replace(definition,$old$'시도가 많아요. 15분 후 다시 시도해주세요.'$old$,$new$format('로그인 시도가 많아요. 약 %s분 후 다시 시도해주세요. 기다리는 동안 다시 눌러도 제한 시간은 늘어나지 않아요.', (select greatest(1,ceil(extract(epoch from (max(blocked_until)-now()))/60)::int) from public.poca3_login_limits where key in (k,'device:'||device) and blocked_until>now()))$new$);
end $migration$;
commit;
