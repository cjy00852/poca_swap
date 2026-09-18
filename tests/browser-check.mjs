import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
const db = new PGlite({extensions:{pgcrypto}});
mkdirSync('test-results',{recursive:true});
await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;create publication supabase_realtime;grant usage on schema public,auth,storage to authenticated,anon;`);
await db.exec(readFileSync('supabase/schema.sql','utf8'));
await db.exec(readFileSync('supabase/migrations/002_shared_catalog.sql','utf8'));
await db.exec('create schema extensions');
await db.exec(readFileSync('supabase/migrations/003_spec.sql','utf8'));
await db.exec(readFileSync('supabase/migrations/004_member_catalog.sql','utf8'));
for(const f of ['005_catalog_edit','006_reset_selections','007_chat','008_signup_device','009_login_wait','010_remove_login_cooldown','011_next_features','012_admin_participants','013_session_management','014_admin_records','015_presence'])await db.exec(readFileSync(`supabase/migrations/${f}.sql`,'utf8'));
const browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
let queue=Promise.resolve();const errors=[];
const X='10000000-0000-0000-0000-000000000001',Y='10000000-0000-0000-0000-000000000002',Z='10000000-0000-0000-0000-000000000003';
async function user(id){
 await db.query('insert into auth.users values($1)',[id]);
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/app.js*',async route=>{const response=await route.fetch();let body=await response.text();body=body.replace('const url = import.meta.env.VITE_SUPABASE_URL, publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;',"const url = 'https://local-test.supabase.co', publicKey = 'test-key';");await route.fulfill({response,body});});
 await page.route('https://local-test.supabase.co/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.startsWith('/auth/')){if(url.pathname.endsWith('/signup') && (await db.query('select 1 from poca3_accounts where owner=$1',[id])).rows.length){id=crypto.randomUUID();await db.query('insert into auth.users values($1)',[id]);}const token=[{alg:'HS256',typ:'JWT'},{sub:id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'signature'].map(v=>typeof v==='string'?v:Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');await route.fulfill({json:{access_token:token,refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user:{id,aud:'authenticated',role:'authenticated',is_anonymous:true}}});return;}
  const task=queue.then(async()=>{
   try{
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
    if(url.pathname.startsWith('/rest/v1/rpc/')){
     const input=route.request().postDataJSON()||{};
     const result=url.pathname.endsWith('poca_presence_ping')?await db.query('select poca_presence_ping($1) as data',[input.tab_id]):url.pathname.endsWith('poca_chat')?await db.query('select poca_chat($1,$2::jsonb) as data',[input.action,JSON.stringify(input.input)]):url.pathname.endsWith('poca_catalog_manage')?await db.query('select poca_catalog_manage($1,$2::jsonb) as data',[input.operation,JSON.stringify(input.input)]):url.pathname.endsWith('poca_reset_selections')?await db.query('select poca_reset_selections($1,$2) as data',[input.selection,input.expected_revision]):url.pathname.endsWith('poca3_state')?await db.query('select poca3_state() as data'):url.pathname.endsWith('poca3_login')?await db.query('select poca3_login($1,$2,$3) as data',[input.nickname,input.pin,input.register]):await db.query('select poca3_action($1,$2::jsonb) as data',[input.action,JSON.stringify(input.input)]);
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
async function join(page,nickname){await page.locator('[data-tab="register"]').click();await page.locator('#day').fill('2026-09-17');await page.locator('#region').fill('서울 더현대');await page.locator('#joinBtn').click();await page.locator('#venue').waitFor();}
async function select(page,type,id){await page.locator('[data-tab="catalog"]').click();await page.locator(`[data-mode="${type}"]`).click();await page.locator(`[data-pick="${id}"]`).click();}
async function qty(page,type,id,n){await page.locator('[data-tab="register"]').click();const input=page.locator(`[data-qty="${id}"][data-kind="${type}"]`);await input.fill(String(n));await input.press('Tab');}
async function login(page,nickname,register=true){await page.locator('#loginNick').fill(nickname);await page.locator('#loginPin').fill('1234');await page.locator(register?'#signupBtn':'#loginBtn').click();await page.locator('#accountPanel').waitFor();}
try{
 const a=await user('00000000-0000-0000-0000-000000000001'),b=await user('00000000-0000-0000-0000-000000000002');
 await login(a,'원이러버');await login(b,'제나러버');await join(a);await join(b);
 await select(a,'give',X);await qty(a,'give',X,2);await select(a,'want',Y);await a.locator('#goRegister').click();await a.locator('#publishBtn').click();
 await select(b,'give',Y);await qty(b,'give',Y,2);await select(b,'want',X);await b.locator('#goRegister').click();await b.locator('#publishBtn').click();await b.locator('[data-request]').waitFor();await b.locator('#matchAlert').waitFor();await b.locator('#matchAlert').click();await refresh(b);await b.waitForTimeout(100);assert.equal(await b.locator('#matchAlert').isVisible(),false);await b.locator('[data-request]').click();
 await refresh(a);await a.locator('[data-tab="matches"]').click();await a.locator('[data-trade-action="accept"]').click();await a.locator('[data-trade-action="extend"]').click();await a.locator('[data-trade-action="extend"][disabled]').waitFor();await a.locator('[data-expires]').filter({hasText:'남은 시간'}).waitFor();await a.locator('[data-trade-action="complete"]').click();
 await refresh(b);await b.locator('[data-tab="register"]').click();await b.locator('#giveN').filter({hasText:'1장'}).waitFor();
 await a.locator('[data-tab="register"]').click();await a.locator('[data-action="here"]').click();await a.locator('#hereDialog').waitFor();assert.match(await a.locator('#hereNumber').textContent(),/#/);await a.locator('#closeHere').click();
 await a.locator('#logoutBtn').click();await a.locator('#loginPanel').waitFor();await login(a,'원이러버',false);await a.locator('[data-tab="history"]').click();await a.locator('#historyList').getByText('교환 완료',{exact:true}).waitFor();
 await a.locator('#logoutBtn').click();await a.locator('#loginPanel').waitFor();await login(a,'새로운계정');
 await a.locator('#logoutBtn').click();await a.locator('#loginPanel').waitFor();await login(a,'원이러버',false);await a.locator('[data-tab="history"]').click();await a.locator('#historyList').getByText('교환 완료',{exact:true}).waitFor();
 await a.locator('[data-tab="catalog"]').click();assert.equal(await a.locator('#addBtn').isVisible(),true);

 await a.locator('#catalogColumns').selectOption('6');assert.equal(await a.locator('.event-grid').first().evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),6);
 await a.locator(`[data-edit-card="${Z}"]`).click();assert.equal(await a.locator('#cardName').inputValue(),'');await a.locator('#cardName').fill('수정한 포카');await a.locator('#catalogRelease').fill('첫 발매');
 const eventBox=await a.locator('#existingEvent').boundingBox(),releaseBox=await a.locator('#existingRelease').boundingBox();assert.equal(eventBox.y,releaseBox.y);assert.ok(releaseBox.x>eventBox.x);

 await a.locator('#existingEvent').selectOption({label:'기존 포카'});assert.equal(await a.locator('#catalogEvent').inputValue(),'기존 포카');await a.locator('#existingKind').selectOption({label:'포카'});assert.equal(await a.locator('#catalogKind').inputValue(),'포카');await a.locator('#existingKind').focus();
 await a.evaluate(()=>{window.editorMutations=0;window.editorObserver=new MutationObserver(()=>window.editorMutations++);window.editorObserver.observe(document.querySelector('#eventOptions'),{childList:true});});
 await refresh(a);await a.waitForTimeout(300);
 assert.equal(await a.evaluate(()=>window.editorMutations),0,'background refresh must not rebuild editor suggestions');
 assert.equal(await a.locator('#editor').evaluate(el=>el.open),true);assert.equal(await a.locator('#cardName').inputValue(),'수정한 포카');
 await a.evaluate(()=>window.editorObserver.disconnect());await a.locator('[data-editor-member="원이"]').click();await a.locator('#saveCard').click();await a.locator('#editor').waitFor({state:'hidden'});
 await a.locator(`[data-delete-card="${Z}"]`).click();await a.locator('#confirmYes').click();await a.locator(`[data-pick="${Z}"]`).waitFor({state:'detached'});await a.locator('#undoCatalogDelete').click();await a.locator(`[data-pick="${Z}"]`).waitFor();
 await a.locator('[data-tab="matches"]').click();await a.locator('[data-chat-peer]').first().click();await a.locator('#chatText').fill('입구 <여기> 앞이에요');await a.locator('#chatSend').click();await a.locator('#chatMessages').getByText('입구 <여기> 앞이에요',{exact:true}).waitFor();await a.locator('#closeChat').click();
 await b.locator('#openChats').click();await b.locator('[data-chat-room]').first().click();await b.locator('#chatMessages').getByText('입구 <여기> 앞이에요',{exact:true}).waitFor();await b.locator('#chatText').fill('지금 갈게요');await b.locator('#chatSend').click();await b.locator('#chatMessages').getByText('지금 갈게요',{exact:true}).waitFor();await b.locator('#closeChat').click();
 await a.locator('[data-tab="register"]').click();assert.ok(await a.locator('.wanted-photo img').count());await a.locator('#resetWant').click();await a.locator('#confirmYes').click();await a.locator('.wanted-photo').waitFor({state:'detached'});assert.equal(await a.locator('#giveN').textContent(),'1장');await a.locator('#resetGive').click();await a.locator('#confirmYes').click();await a.locator('#giveN').filter({hasText:'0장'}).waitFor();
 assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS spec browser: login, per-card choices, reservation, mutual completion, recovery, number display and mobile layout');
}finally{await browser.close();await db.close();}
