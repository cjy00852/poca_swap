import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002',C='00000000-0000-0000-0000-000000000003';
const X='10000000-0000-0000-0000-000000000001',Y='10000000-0000-0000-0000-000000000002';
const pick=(id,qty)=>({id,qty});
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;create publication supabase_realtime;grant usage on schema public,auth,storage to authenticated,anon;grant select,insert on storage.objects to authenticated;insert into auth.users values('${A}'),('${B}'),('${C}');`);
 await db.exec(readFileSync('supabase/schema.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/002_shared_catalog.sql','utf8'));
 return db;
}
async function user(db,id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
async function act(db,action,input={}){return(await db.query('select poca2_action($1,$2::jsonb) as data',[action,JSON.stringify(input)])).rows[0].data;}
async function state(db){return(await db.query('select poca2_state() as data')).rows[0].data;}
async function publish(db,give,want,revision){return act(db,'publish',{give,want,revision:revision??(await state(db)).me.revision});}
test('beta2 nickname uniqueness, real dates, catalog identity, quantity validation and atomic partial completion',async()=>{
 const db=await setup();try{
 await user(db,A);let s=await act(db,'join',{nickname:'원이 러버',day:'2026-09-17'});
 await publish(db,[{...pick(X,3),name:'가짜 이름',img:'evil'}],[pick(Y,2)]);
 s=await state(db);assert.equal(s.me.give[0].name,'포카 1');const oldRevision=s.me.revision;
 await user(db,B);assert.equal((await act(db,'nickname',{nickname:'원이러버'})).available,false);
 await assert.rejects(()=>act(db,'join',{nickname:'원이러버',day:'2026-09-18'}));
 await assert.rejects(()=>act(db,'join',{nickname:'B',day:'2026-02-30'}));
 await act(db,'join',{nickname:'B',day:'2026-09-17'});
 s=await publish(db,[pick(Y,5)],[pick(X,4)]);assert.equal(s.matches.length,1);assert.equal(s.matches[0].maxQty,2);
 await user(db,C);await act(db,'join',{nickname:'C',day:'2026-09-18'});await publish(db,[pick(Y,1)],[pick(X,1)]);s=await state(db);assert.equal(s.matches.length,0);assert.equal(s.listings.length,0);assert.equal(s.catalog.length,5);
 await assert.rejects(()=>db.query('select * from poca2_members'));await assert.rejects(()=>db.query('select poca2_matches($1)',[A]));
 await user(db,A);
 for(const qty of [0,-1,1.5,100,'1.5',null])await assert.rejects(()=>publish(db,[pick(X,qty)],[pick(Y,1)]));
 await assert.rejects(()=>publish(db,[pick(X,1),pick(X,1)],[]));await assert.rejects(()=>publish(db,[pick('invalid',1)],[]));
 await assert.rejects(()=>act(db,'request',{peerId:B,giveId:X,receiveId:Y,quantity:3}));
 s=await act(db,'request',{peerId:B,giveId:X,receiveId:Y,quantity:2});const id=s.trades[0].id;
 await assert.rejects(()=>act(db,'confirm',{id}));await user(db,C);await assert.rejects(()=>act(db,'confirm',{id}));
 await user(db,B);s=await act(db,'confirm',{id});assert.equal(s.me.give[0].qty,3);assert.equal(s.me.want[0].qty,2);assert.equal(s.trades[0].give.qty,2);assert.equal(s.trades[0].status,'completed');await assert.rejects(()=>act(db,'confirm',{id}));
 await user(db,A);s=await state(db);assert.equal(s.me.give[0].qty,1);assert.equal(s.me.want.length,0);assert.equal(s.catalog.length,5);assert.equal(s.matches.length,0);
 await assert.rejects(()=>publish(db,[pick(X,3)],[pick(Y,2)],oldRevision));
 await act(db,'leave');s=await state(db);assert.equal(s.me.day,null);assert.equal(s.me.give.length,0);assert.equal(s.catalog.length,5);assert.equal(s.trades.length,1);
 await user(db,C);await assert.rejects(()=>act(db,'join',{nickname:'원이러버',day:'2026-09-18'}));
 }finally{await db.close();}
});
test('beta2 shared catalog is permanent, deduplicated, immutable, and its photos can be used by any member',async()=>{
 const db=await setup();try{
 await user(db,A);const img=`${A}/photo.jpg`;
 await db.query('insert into storage.objects(bucket_id,name) values ($1,$2)',['poca-photos',img]);
 await user(db,B);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
 const info={name:'뱃지 원이',event:'2026 팬미팅',kind:'뱃지',member:'원이',img};
 await assert.rejects(()=>act(db,'catalog_add',info));
 await user(db,A);let s=await act(db,'catalog_add',info);const id=s.addedId;assert.ok(id);
 await assert.rejects(()=>act(db,'catalog_add',{...info,name:'뱃지원이',event:'2026팬미팅'}));
 await assert.rejects(()=>db.query("update poca_catalog set name='변경' where id=$1",[id]));
 await user(db,B);s=await state(db);assert.equal(s.catalog.find(c=>c.id===id).name,'뱃지 원이');assert.equal((await db.query('select * from storage.objects')).rows.length,1);
 await act(db,'join',{nickname:'B',day:'2026-09-17'});s=await publish(db,[pick(id,4)],[pick(X,2)]);assert.equal(s.me.give[0].img,img);await act(db,'leave');assert.equal((await state(db)).catalog.length,6);
 await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");await db.exec('set role anon');await assert.rejects(()=>state(db));
 }finally{await db.close();}
});
test('beta2 retains old history and cancels pending trades when listings or participation change',async()=>{
 const db=await setup();try{
 await user(db,A);await db.query("select poca_action('join',$1::jsonb)",[JSON.stringify({nickname:'old',room:'OLD'})]);
 await db.exec('reset role');await db.query('insert into poca_members(id,nickname) values($1,$2)',[B,'old B']);await db.query("insert into poca_trades(sender,recipient,status,payload) values($1,$2,'completed',$3::jsonb)",[A,B,JSON.stringify({from:A,to:B,fromNick:'old',toNick:'old B',give:{id:'old',name:'옛 이름',img:'images/poca_01.jpg'},receive:{id:'old2',name:'옛 포카',img:'images/poca_02.jpg'},completedAt:'2026-09-01'})]);
 await user(db,A);let s=await act(db,'join',{nickname:'A',day:'2026-09-17'});assert.equal(s.trades[0].legacy,true);assert.equal(s.trades[0].give.name,'옛 이름');assert.equal((await db.query('select poca_state() as data')).rows[0].data.me.room,'');
 await publish(db,[pick(X,2)],[pick(Y,2)]);await user(db,B);await act(db,'join',{nickname:'B',day:'2026-09-17'});await publish(db,[pick(Y,2)],[pick(X,2)]);
 await user(db,A);s=await act(db,'request',{peerId:B,giveId:X,receiveId:Y,quantity:1});const pending=s.trades.find(t=>t.status==='pending');
 await user(db,B);await act(db,'leave');await user(db,A);s=await state(db);assert.ok(!s.trades.some(t=>t.status==='pending'));await assert.rejects(()=>act(db,'confirm',{id:pending.id}));
 }finally{await db.close();}
});
