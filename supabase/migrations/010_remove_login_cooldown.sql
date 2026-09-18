-- Remove login cooldown; correct PIN is still required.
begin;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.poca3_login(text,text,boolean)'::regprocedure) into definition;
 definition := replace(definition, ' lockrow public.poca3_login_limits;', '');
 definition := regexp_replace(definition, E'^[^\n]*public\.poca3_login_limits[^\n]*\n', '', 'gn');
 execute definition;
end $migration$;
commit;
