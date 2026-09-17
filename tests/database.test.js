import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const A='00000000-0000-0000-0000-000000000001', B='00000000-0000-0000-0000-000000000002', C='00000000-0000-0000-0000-000000000003';
const card=(id,name)=>({id,name,img:'images/poca_01.jpg'});
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
 create publication supabase_realtime;
 grant usage on schema public,auth,storage to authenticated,anon;
 grant select,insert on storage.objects to authenticated;
 insert into auth.users values ('${A}'),('${B}'),('${C}');`);
 await db.exec(readFileSync(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
 return db;
}
async function as(db,id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role authenticated');}
async function action(db,name,input={}){return (await db.query('select public.poca_action($1,$2::jsonb) as data',[name,JSON.stringify(input)])).rows[0].data;}
async function state(db){return(await db.query('select public.poca_state() as data')).rows[0].data;}
test('real matching, participant authorization, atomic completion, history, withdrawal and room isolation',async()=>{
 const db=await setup();try{
 await as(db,A);await action(db,'join',{nickname:'원이짱',room:'SEOUL'});await action(db,'publish',{give:[card('a','뱃지 원이'),card('a2','별도 포카')],want:[card('aw','MD원이')]});
 await as(db,B);await action(db,'join',{nickname:'교환러',room:'seoul'});let s=await action(db,'publish',{give:[card('b','MD 원이')],want:[card('bw','뱃지원이')]});assert.equal(s.matches.length,1);assert.equal(s.count,2);
 await as(db,C);await action(db,'join',{nickname:'다른현장',room:'BUSAN'});s=await state(db);assert.equal(s.listings.length,0);assert.equal(s.matches.length,0);
 await assert.rejects(()=>action(db,'request',{peerId:A,giveId:'a',receiveId:'b'}));
 await assert.rejects(()=>db.query('select * from public.poca_members'));
 await assert.rejects(()=>db.query('select public.poca_matches($1)',[A]));
 await as(db,A);s=await action(db,'request',{peerId:B,giveId:'a',receiveId:'b'});const id=s.trades[0].id;
 await assert.rejects(()=>action(db,'confirm',{id}));
 await as(db,C);await assert.rejects(()=>action(db,'confirm',{id}));
 await as(db,B);s=await action(db,'confirm',{id});assert.equal(s.me.give.length,0);assert.equal(s.me.want.length,0);assert.equal(s.trades[0].status,'completed');assert.equal(s.matches.length,0);
 await assert.rejects(()=>action(db,'confirm',{id}));
 await as(db,A);s=await state(db);assert.deepEqual(s.me.give.map(x=>x.id),['a2']);assert.equal(s.me.want.length,0);assert.equal(s.trades[0].give.name,'뱃지 원이');
 await assert.rejects(()=>action(db,'publish',{give:[card('a','뱃지 원이')],want:[]}));
 await action(db,'leave');s=await state(db);assert.equal(s.me.room,'');assert.equal(s.me.give.length,0);assert.equal(s.trades.length,1);
 await as(db,B);s=await state(db);assert.equal(s.count,1);assert.equal(s.listings.length,0);
 }finally{await db.close();}
});
test('pending trades are cancelled on edit/exit; invalid writes roll back; private photo policies',async()=>{
 const db=await setup();try{
 await as(db,A);await action(db,'join',{nickname:'A',room:'TEST'});await action(db,'publish',{give:[card('a','뱃지')],want:[card('aw','MD')]});
 await assert.rejects(()=>action(db,'publish',{give:[{...card('x','X'),img:`${B}/other.jpg`}],want:[]}));
 assert.equal((await state(db)).me.give[0].id,'a');
 await assert.rejects(()=>action(db,'publish',{give:[card('a','X'),card('a','Y')],want:[]}));
 await as(db,B);await action(db,'join',{nickname:'B',room:'TEST'});await action(db,'publish',{give:[card('b','MD')],want:[card('bw','뱃지')]});
 let s=await action(db,'request',{peerId:A,giveId:'b',receiveId:'a'});assert.equal(s.trades.length,1);
 await as(db,A);s=await action(db,'publish',{give:[card('a','뱃지')],want:[card('aw','MD')]});assert.equal(s.trades.length,0);
 await action(db,'request',{peerId:B,giveId:'a',receiveId:'b'});await action(db,'leave');
 await as(db,B);assert.equal((await state(db)).trades.length,0);
 await db.query('insert into storage.objects(bucket_id,name) values ($1,$2)',['poca-photos',`${B}/photo.jpg`]);
 await assert.rejects(()=>db.query('insert into storage.objects(bucket_id,name) values ($1,$2)',['poca-photos',`${A}/spoof.jpg`]));
 assert.equal((await db.query('select * from storage.objects')).rows.length,1);
 await as(db,C);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
 await as(db,null);await assert.rejects(()=>state(db));
 }finally{await db.close();}
});
