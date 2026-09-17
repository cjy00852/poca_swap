import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import {readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
mkdirSync('test-results',{recursive:true});
await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;create publication supabase_realtime;grant usage on schema public,auth,storage to authenticated,anon;`);
await db.exec(readFileSync('supabase/schema.sql','utf8'));
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});let queue=Promise.resolve();const errors=[];
async function user(id,nickname){
 await db.query('insert into auth.users values($1)',[id]);const ctx=await browser.newContext({viewport:{width:390,height:844}});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/app.js*',async route=>{const r=await route.fetch();let source=await r.text();source=source.replace('const url = import.meta.env.VITE_SUPABASE_URL, publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;',"const url = 'https://local-test.supabase.co', publicKey = 'test-key';");await route.fulfill({response:r,body:source});});
 await page.route('https://local-test.supabase.co/**',async route=>{
  const u=new URL(route.request().url());if(u.pathname.startsWith('/auth/')){const token=[{alg:'HS256',typ:'JWT'},{sub:id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'signature'].map(x=>typeof x==='string'?x:Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');await route.fulfill({json:{access_token:token,refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user:{id,aud:'authenticated',role:'authenticated',is_anonymous:true}}});return;}
  if(u.pathname.startsWith('/rest/v1/rpc/')){const task=queue.then(async()=>{try{await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);const input=route.request().postDataJSON()||{};const r=u.pathname.endsWith('poca_state')?await db.query('select poca_state() as data'):await db.query('select poca_action($1,$2::jsonb) as data',[input.action,JSON.stringify(input.input)]);await route.fulfill({json:r.rows[0].data});}catch(e){await route.fulfill({status:400,json:{message:e.message}});}});queue=task.catch(()=>{});await task;return;}
  await route.fulfill({json:{}});
 });
 await page.goto('http://127.0.0.1:5173');await page.locator('#nick').fill(nickname);await page.locator('#room').fill('현장테스트');await page.locator('#joinBtn').click();await page.locator('#venue').waitFor();return page;
}
async function refresh(page){await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
try{
 const a=await user('00000000-0000-0000-0000-000000000001','닉네임열글자테스트');
 const b=await user('00000000-0000-0000-0000-000000000002','교환상대');
 await a.locator('[data-pick="1"]').click();await a.locator('[data-mode="want"]').click();await a.locator('[data-pick="2"]').click();await a.locator('#publishBtn').click();
 await b.locator('[data-pick="2"]').click();await b.locator('[data-mode="want"]').click();await b.locator('[data-pick="1"]').click();await b.locator('#publishBtn').click();await b.locator('[data-request]').waitFor();
 await refresh(a);await a.locator('[data-request]').waitFor();await a.locator('[data-request]').click();await a.getByText('상대 확인 대기',{exact:true}).waitFor();
 await refresh(b);await b.locator('[data-confirm-trade]').click();await b.locator('#confirmYes').click();await b.getByText('교환 완료! 거래 내역에 저장했어요.',{exact:true}).waitFor();
 await refresh(a);await a.getByRole('button',{name:'거래 내역',exact:true}).click();await a.locator('#historyList .match').waitFor();assert.equal(await a.locator('#badge').textContent(),'0');
 await a.getByRole('button',{name:'내 포카',exact:true}).click();assert.equal(await a.locator('[data-pick="1"]').count(),0);
 await a.locator('#venue [data-action="here"]').click();assert.equal(await a.locator('#bigNick').textContent(),'닉네임열글자테스트');await a.screenshot({path:'test-results/here.png'});await a.locator('#closeHere').click();
 await a.locator('#leaveBtn').click();await a.locator('#confirmYes').click();await a.locator('#joinForm').waitFor();await a.getByRole('button',{name:'거래 내역',exact:true}).click();assert.equal(await a.locator('#historyList .match').count(),1);
 await refresh(b);await b.getByRole('button',{name:'내 포카',exact:true}).click();await b.getByText('1명 참여 중',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS two-browser Supabase client + PostgreSQL RPC: join, matching, bilateral completion, removed inventory, history, large nickname, withdrawal');
}finally{await browser.close();await db.close();}


