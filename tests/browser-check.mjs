import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
mkdirSync('test-results',{recursive:true});
await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;create publication supabase_realtime;grant usage on schema public,auth,storage to authenticated,anon;`);
await db.exec(readFileSync('supabase/schema.sql','utf8'));
await db.exec(readFileSync('supabase/migrations/002_shared_catalog.sql','utf8'));
const browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
let queue=Promise.resolve();const errors=[];
const X='10000000-0000-0000-0000-000000000001',Y='10000000-0000-0000-0000-000000000002',Z='10000000-0000-0000-0000-000000000003';
async function user(id){
 await db.query('insert into auth.users values($1)',[id]);
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/app.js*',async route=>{const response=await route.fetch();let body=await response.text();body=body.replace('const url = import.meta.env.VITE_SUPABASE_URL, publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;',"const url = 'https://local-test.supabase.co', publicKey = 'test-key';");await route.fulfill({response,body});});
 await page.route('https://local-test.supabase.co/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.startsWith('/auth/')){const token=[{alg:'HS256',typ:'JWT'},{sub:id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'signature'].map(v=>typeof v==='string'?v:Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');await route.fulfill({json:{access_token:token,refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user:{id,aud:'authenticated',role:'authenticated',is_anonymous:true}}});return;}
  const task=queue.then(async()=>{
   try{
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
    if(url.pathname.startsWith('/rest/v1/rpc/')){
     const input=route.request().postDataJSON()||{};
     const result=url.pathname.endsWith('poca2_state')?await db.query('select poca2_state() as data'):await db.query('select poca2_action($1,$2::jsonb) as data',[input.action,JSON.stringify(input.input)]);
     await route.fulfill({json:result.rows[0].data});
    }else if(url.pathname==='/storage/v1/object/sign/poca-photos'){
     const input=route.request().postDataJSON();await route.fulfill({json:input.paths.map(path=>({path,signedURL:`/object/sign/poca-photos/${path}?token=test`}))});
    }else if(url.pathname.startsWith('/storage/v1/object/sign/')){
     await route.fulfill({contentType:'image/jpeg',body:readFileSync('images/poca_01.jpg')});
    }else if(url.pathname.startsWith('/storage/v1/object/poca-photos/')&&route.request().method()==='POST'){
     const name=url.pathname.split('/object/poca-photos/')[1];await db.query("insert into storage.objects(bucket_id,name) values('poca-photos',$1)",[name]);await route.fulfill({json:{Key:`poca-photos/${name}`}});
    }else await route.fulfill({json:{}});
   }catch(e){await route.fulfill({status:400,json:{message:e.message}});}
  });queue=task.catch(()=>{});await task;
 });
 await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5173');await page.locator('#catalogCount').filter({hasText:'전체 5종'}).waitFor();return page;
}
async function refresh(page){await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
async function join(page,nickname){await page.locator('[data-tab="register"]').click();await page.locator('#nick').fill(nickname);await page.locator('#day').fill('2026-09-17');await page.locator('#joinBtn').click();await page.locator('#venue').waitFor();}
async function select(page,type,id){await page.locator('[data-tab="catalog"]').click();await page.locator(`[data-mode="${type}"]`).click();await page.locator(`[data-pick="${id}"]`).click();}
async function qty(page,type,id,n){await page.locator('[data-tab="register"]').click();const input=page.locator(`[data-qty="${id}"][data-kind="${type}"]`);await input.fill(String(n));await input.press('Tab');}
try{
 const a=await user('00000000-0000-0000-0000-000000000001'),b=await user('00000000-0000-0000-0000-000000000002');
 await select(a,'give',X);await join(a,'원이러버');assert.equal(await a.locator('#giveN').textContent(),'1장');
 await qty(a,'give',X,3);await select(a,'give',Z);await select(a,'want',Y);await qty(a,'want',Y,2);await a.locator('#publishBtn').click();
 await join(b,'메이러버');await select(b,'give',Y);await qty(b,'give',Y,3);await select(b,'want',X);await qty(b,'want',X,2);await b.locator('#publishBtn').click();
 await b.locator('[data-request]').waitFor();await refresh(a);await a.locator('[data-request]').waitFor();await a.locator('#tradeQty0').fill('2');await a.locator('[data-request]').click();await a.getByText('상대 확인 대기',{exact:true}).waitFor();
 await refresh(b);await b.locator('[data-confirm-trade]').click();await b.locator('#confirmYes').click();await b.getByText('교환 완료! 남은 수량과 거래 내역을 반영했어요.',{exact:true}).waitFor();
 await refresh(a);await a.locator('[data-tab="register"]').click();await a.locator('#wantN').filter({hasText:'0장'}).waitFor();assert.equal(await a.locator(`[data-qty="${X}"]`).inputValue(),'1');
 await a.locator('#venue [data-action="here"]').click();assert.equal(await a.locator('#herePhoto img').count(),1);assert.equal(await a.locator('#hereName').textContent(),'포카 1');await a.locator('#nextCard').click();assert.equal(await a.locator('#hereName').textContent(),'포카 3');assert.equal(await a.locator('#herePager').textContent(),'2 / 2');await a.screenshot({path:'test-results/beta2-here.png'});await a.locator('#closeHere').click();
 await a.locator('[data-tab="catalog"]').click();assert.equal(await a.locator(`[data-pick="${X}"]`).count(),1);
 await a.locator('#addBtn').click();await a.locator('#photo').setInputFiles('images/poca_01.jpg');await a.locator('#catalogEvent').fill('2026 팬미팅');await a.locator('#catalogKind').fill('뱃지');await a.locator('#catalogMember').fill('원이');await a.locator('#cardName').fill('뱃지 원이 <A>');await a.locator('#saveCard').click();await a.locator('#editor').waitFor({state:'hidden'});
 await refresh(b);await b.locator('[data-tab="catalog"]').click();await b.locator('#cards').getByText('뱃지 원이 <A>',{exact:true}).waitFor();await b.locator('#eventFilter').selectOption('2026 팬미팅');assert.equal(await b.locator('#cards .card').count(),1);await b.locator('#eventFilter').selectOption('');
 await a.reload();await a.locator('#cards').getByText('뱃지 원이 <A>',{exact:true}).waitFor();await a.screenshot({path:'test-results/beta2-catalog.png',fullPage:true});
 assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await a.locator('[data-tab="register"]').click();await a.locator('#leaveBtn').click();await a.locator('#confirmYes').click();await a.locator('#joinForm').waitFor();await a.locator('[data-tab="history"]').click();assert.equal(await a.locator('#historyList .match').count(),1);
 await a.locator('[data-tab="catalog"]').click();await a.locator('#cards').getByText('뱃지 원이 <A>',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS beta2 two-browser shared catalog, canonical names, pre-join selection, quantities, partial completion, persistent catalog/history, one-photo carousel, date exit, mobile layout');
}finally{await browser.close();await db.close();}

