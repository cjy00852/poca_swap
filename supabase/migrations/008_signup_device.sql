-- Preserve existing owners; the client obtains a fresh anonymous device for another signup.
begin;
create or replace function public.poca3_login(nickname text,pin text,register boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare device uuid:=auth.uid(); a public.poca3_accounts; k text:=public.poca_name(trim(nickname)); n text:=trim(nickname); lockrow public.poca3_login_limits;
begin
 if device is null then raise exception '연결 후 다시 시도해주세요.'; end if;
 if length(n) not between 1 and 10 or coalesce(pin,'') !~ '^[0-9]{4}$' then return jsonb_build_object('error','닉네임 1~10자와 숫자 4자리 PIN을 입력해주세요.'); end if;
 perform pg_advisory_xact_lock(74109202);
 insert into public.poca3_login_limits(key) values(k),('device:'||device) on conflict do nothing;
 if exists(select 1 from public.poca3_login_limits where key in (k,'device:'||device) and blocked_until>now()) then return jsonb_build_object('error','시도가 많아요. 15분 후 다시 시도해주세요.'); end if;
 select * into a from public.poca3_accounts where public.poca_name(poca3_accounts.nickname)=k;
 if register then
 if a.owner is not null or exists(select 1 from public.poca2_members where public.poca_name(poca2_members.nickname)=k and id<>device) then return jsonb_build_object('error','이미 등록된 닉네임 또는 계정이에요. 로그인해주세요.'); end if;
 if exists(select 1 from public.poca3_accounts where owner=device) then return jsonb_build_object('error','새 가입을 위한 연결을 다시 준비해주세요.','code','DEVICE_ACCOUNT_EXISTS'); end if;
 insert into public.poca3_accounts values(device,n,extensions.crypt(pin,extensions.gen_salt('bf',10))) returning * into a;
 else
 if a.owner is null or a.pin_hash<>extensions.crypt(pin,a.pin_hash) then
 update public.poca3_login_limits set failures=case when blocked_until<=now() then 1 else failures+1 end,blocked_until=case when blocked_until<=now() then null when failures>=4 then now()+interval '15 minutes' else blocked_until end where key in (k,'device:'||device);
 return jsonb_build_object('error','닉네임 또는 PIN이 맞지 않아요.');
 end if;
 end if;
 update public.poca3_login_limits set failures=0,blocked_until=null where key in (k,'device:'||device);
 insert into public.poca3_sessions values(device,a.owner,now()+interval '30 days') on conflict on constraint poca3_sessions_pkey do update set owner=excluded.owner,expires_at=excluded.expires_at;
 return public.poca3_state();
end $$;
commit;
