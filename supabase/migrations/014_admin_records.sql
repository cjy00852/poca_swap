begin;
create function public.poca_admin_records(section text,query text default '',page integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
 if not public.poca3_is_admin() then raise exception '관리자만 등록·완료 내역을 확인할 수 있어요.'; end if;
 if page<0 or page>100000 then raise exception '페이지를 확인해주세요.'; end if;
 if section='listings' then
 select coalesce(jsonb_agg(to_jsonb(p)),'[]') into rows from (
 select nickname,day,region,exchange_no as "exchangeNo",give,conditions from public.poca2_members
 where day is not null and jsonb_array_length(give)>0 and (coalesce(query,'')='' or strpos(public.poca_name(nickname||' '||day::text||' '||region),public.poca_name(query))>0)
 order by day desc,region,exchange_no limit 51 offset page*50) p;
 elsif section='completed' then
 select coalesce(jsonb_agg(t.payload),'[]') into rows from (
 select payload,id,created_at from public.poca2_trades where status='completed'
 union all select payload,id,created_at from public.poca_trades where status='completed'
 ) t where coalesce(query,'')='' or strpos(public.poca_name(coalesce(t.payload->>'fromNick','')||' '||coalesce(t.payload->>'toNick','')||' '||coalesce(t.payload->>'room','')),public.poca_name(query))>0;
 -- Sort and paginate by completion time, including previous-version completed exchanges.
 select coalesce(jsonb_agg(v),'[]') into rows from (select v from jsonb_array_elements(rows) v order by v->>'completedAt' desc nulls last,v::text limit 51 offset page*50) p;
 else raise exception '목록을 선택해주세요.';
 end if;
 return jsonb_build_object('rows',(select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(rows) with ordinality r(v,n) where n<=50),'hasMore',jsonb_array_length(rows)>50);
end $$;
revoke all on function public.poca_admin_records(text,text,integer) from public,anon,authenticated;
grant execute on function public.poca_admin_records(text,text,integer) to authenticated;
commit;
