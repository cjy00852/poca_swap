import { createClient } from '@supabase/supabase-js';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaults = Array.from({length:5}, (_,i) => ({id:String(i+1),name:`포카 ${i+1}`,img:`images/poca_0${i+1}.jpg`}));
let draft;
try { draft = JSON.parse(localStorage.getItem('pocaDraftV2')); } catch {}
if (!draft || !Array.isArray(draft.cards) || !Array.isArray(draft.give) || !Array.isArray(draft.want)) {
  let old; try { old = JSON.parse(localStorage.getItem('pocaBeta')); } catch {}
  draft = {cards: defaults, give: (old?.give || []).map(String), want:(old?.want || []).map(String)};
}
let mode = 'give', current = {me:null,matches:[],listings:[],trades:[],count:0};
let client, channel, channelRoom, busy = false, editing, photoData, photoLoading = false, refreshSequence = 0;
const url = import.meta.env.VITE_SUPABASE_URL, publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = /^https:\/\//.test(url || '') && !!publicKey && !url.includes('YOUR_PROJECT');
const photoURLs = new Map();
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4000); }
function saveDraft() {
 try { localStorage.setItem('pocaDraftV2', JSON.stringify(draft)); return true; }
 catch { toast('기기 저장 공간이 부족해요. 이번 변경은 새로고침하면 사라질 수 있어요.'); return false; }
}
function showTab(tab) { $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); $$('.section').forEach(s => s.classList.toggle('active-section', s.id === tab)); }
function imageURL(card) { return /^(images\/poca_0[1-5]\.jpg|data:image\/jpeg;base64,)/.test(card.img) ? card.img : photoURLs.get(card.img)?.url || ''; }
function photo(card) { const src = imageURL(card); return src ? `<img src="${esc(src)}" alt="${esc(card.name)}" loading="lazy">` : '<span>사진 불러오는 중</span>'; }
function swap(give, receive) { return `<div class="swap"><div>${photo(give)}<small>내가 드려요</small><b>${esc(give.name)}</b></div><span>⇄</span><div>${photo(receive)}<small>내가 받아요</small><b>${esc(receive.name)}</b></div></div>`; }
function renderCards() {
 $('#cards').innerHTML = draft.cards.map(c => `<article class="card ${draft[mode].includes(c.id)?'selected':''}"><button class="pick" data-pick="${esc(c.id)}" aria-pressed="${draft[mode].includes(c.id)}">${photo(c)}<strong>${esc(c.name)}</strong><span>${draft[mode].includes(c.id)?'✓ 선택됨':'선택하기'}</span></button><button class="edit" data-edit="${esc(c.id)}">이름 · 사진 수정</button></article>`).join('');
 $('#giveN').textContent = draft.give.length; $('#wantN').textContent = draft.want.length;
 $('#publishBtn').disabled = busy || !current.me?.room;
 $('#draftNote').textContent = !configured ? '연결 준비 중이에요. 사진과 이름을 먼저 준비할 수 있어요.' : !current.me?.room ? '현장에 입장한 뒤 선택한 포카를 올려주세요.' : '선택·수정 후 아래 버튼을 눌러 현장 목록에 반영해주세요.';
}
function render() {
 const me = current.me, joined = !!me?.room;
 $('#joinForm').hidden = joined; $('#venue').hidden = !joined;
 $('#joinBtn').disabled = busy || !configured; $('#leaveBtn').disabled = busy;
 $('#venueName').textContent = me?.room || ''; $('#myNickname').textContent = `${me?.nickname || ''}님으로 참여 중`;
 $('#count').textContent = `${current.count}명 참여 중`; $('#badge').textContent = current.matches.length; $('#matchCount').textContent = current.matches.length;
 $('#pendingList').innerHTML = current.trades.filter(t => t.status === 'pending').map(t => {
  const sender = t.from === me?.id;
  return `<article class="match"><span class="pill">${sender?'상대 확인 대기':'완료 확인 요청'}</span><h2>${esc(sender?t.toNick:t.fromNick)}님과 교환</h2>${swap(sender?t.give:t.receive,sender?t.receive:t.give)}<div class="actions">${sender?'':`<button data-confirm-trade="${t.id}">교환 완료 확인</button>`}<button data-cancel-trade="${t.id}">${sender?'요청 취소':'아직 교환 안 했어요'}</button></div></article>`;
 }).join('');
 $('#matchList').innerHTML = current.matches.map((m,i) => `<article class="match"><div class="top"><h2>${esc(m.nickname)}님</h2><span class="pill">서로 일치</span></div>${swap(m.give,m.receive)}<div class="actions"><button data-request="${i}" ${busy?'disabled':''}>교환 완료 요청</button><button data-action="here">여기 있어요</button></div></article>`).join('') || `<div class="empty">${joined?'아직 서로 맞는 포카가 없어요.<br>포카를 올리고 상대방의 등록을 기다려주세요.':'같은 현장 코드로 입장하면 서로의 포카를 볼 수 있어요.'}</div>`;
 $('#listingList').innerHTML = current.listings.filter(p => p.give.length || p.want.length).map(p => `<article class="match"><h2>${esc(p.nickname)}님</h2><p><b>내놓아요</b> ${p.give.map(c=>esc(c.name)).join(', ') || '없음'}</p><p><b>구해요</b> ${p.want.map(c=>esc(c.name)).join(', ') || '없음'}</p></article>`).join('') || '<div class="empty">아직 다른 사람이 올린 포카가 없어요.</div>';
 $('#historyList').innerHTML = current.trades.filter(t => t.status === 'completed').map(t => {
  const sender = t.from === me?.id;
  return `<article class="match"><span class="pill">교환 완료</span><h2>${esc(sender?t.toNick:t.fromNick)}님과 교환</h2>${swap(sender?t.give:t.receive,sender?t.receive:t.give)}<p class="muted">${esc(t.room)} · ${esc(new Date(t.completedAt).toLocaleString('ko-KR'))}</p></article>`;
 }).join('') || '<div class="empty">아직 완료한 거래가 없어요.</div>';
 renderCards();
}
async function loadPhotos() {
 if (!client) return;
 const cards = [...draft.cards, ...(current.me?.give||[]), ...(current.me?.want||[]), ...current.matches.flatMap(m=>[m.give,m.receive]), ...current.trades.flatMap(t=>[t.give,t.receive])];
 const paths = [...new Set(cards.map(c=>c.img).filter(p=>!p.startsWith('images/')&&!p.startsWith('data:')&&(!photoURLs.has(p)||photoURLs.get(p).expires < Date.now())))];
 if (!paths.length) return;
 const {data,error} = await client.storage.from('poca-photos').createSignedUrls(paths,3600);
 if (!error) { for (const p of data) if (p.signedUrl) photoURLs.set(p.path,{url:p.signedUrl,expires:Date.now()+3300000}); render(); }
}
function apply(next) {
 const previous = current.me;
 if (next.me) {
  if (!previous) {
   for (const c of [...next.me.give,...next.me.want]) if (!draft.cards.some(x=>x.id===c.id)) draft.cards.push(c);
   if (next.me.give.length || next.me.want.length) { draft.give = next.me.give.map(c=>c.id); draft.want = next.me.want.map(c=>c.id); }
  } else {
   for (const type of ['give','want']) {
    const removed = previous[type].filter(c=>!next.me[type].some(n=>n.id===c.id)).map(c=>c.id);
    draft[type] = draft[type].filter(id=>!removed.includes(id));
   }
   if (previous.room && !next.me.room) { draft.give=[]; draft.want=[]; }
  }
  // A traded-away card must not silently reappear in the selectable inventory after reload.
  const completed = next.trades.filter(t=>t.status==='completed').map(t=>t.from===next.me.id?t.give.id:t.receive.id);
  draft.cards = draft.cards.filter(c=>!completed.includes(c.id)); draft.give = draft.give.filter(id=>!completed.includes(id)); draft.want = draft.want.filter(id=>!completed.includes(id));
 }
 current=next; saveDraft(); render(); void loadPhotos(); subscribe();
}
function subscribe() {
 const room = current.me?.room || '';
 if (!client || channelRoom === room) return;
 if (channel) void client.removeChannel(channel);
 channelRoom=room; channel=null;
 if (room) channel=client.channel(`venue-${crypto.randomUUID()}`).on('postgres_changes',{event:'*',schema:'public',table:'poca_rooms'},()=>void refresh()).subscribe(status=>{
   $('#connection').textContent=status==='SUBSCRIBED'?'● 실시간 연결':'연결 확인 중';
   if(status==='SUBSCRIBED') void refresh();
 });
}
async function refresh() {
 if (!client) return;
 const seq=++refreshSequence;
 const {data,error}=await client.rpc('poca_state');
 if(seq!==refreshSequence) return;
 if(error) { $('#connection').textContent='연결 재시도 중'; return; }
 apply(data); $('#connection').textContent=current.me?.room?'● 현장 연결됨':'● 연결됨';
}
async function action(name,input={}) {
 if (!client) throw new Error('Supabase 연결 설정이 필요해요.');
 ++refreshSequence;
 const {data,error}=await client.rpc('poca_action',{action:name,input});
 if(error) throw error;
 ++refreshSequence; apply(data); return data;
}
async function run(task) { if(busy) return; busy=true; render(); try { await task(); } catch(e) { toast(e.message || '처리하지 못했어요. 다시 시도해주세요.'); } finally { busy=false; render(); } }
function confirm(title,text) {
 $('#confirmTitle').textContent=title; $('#confirmText').textContent=text; $('#confirmDialog').showModal();
 return new Promise(resolve=>{ const close=()=>{ $('#confirmDialog').close(); resolve(false); }; $('#confirmNo').onclick=close; $('#confirmDialog').oncancel=e=>{e.preventDefault();close();}; $('#confirmYes').onclick=()=>{$('#confirmDialog').close();resolve(true);}; });
}
function here() { if(!current.me?.room) return toast('현장에 먼저 입장해주세요.'); $('#bigNick').textContent=current.me.nickname; $('#hereRoom').textContent=current.me.room; $('#hereDialog').showModal(); }
$$('nav button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$$('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode; $$('[data-mode]').forEach(x=>x.classList.toggle('on',x===b));renderCards();});
$('#joinForm').onsubmit=e=>{e.preventDefault();void run(async()=>{await action('join',{nickname:$('#nick').value.trim(),room:$('#room').value.trim()});localStorage.setItem('pocaNick',$('#nick').value.trim());toast('현장에 입장했어요. 포카를 선택해 올려주세요.');});};
$('#publishBtn').onclick=()=>void run(async()=>{
 const uploaded=new Map();
 for(const id of new Set([...draft.give,...draft.want])) {
  const c=draft.cards.find(c=>c.id===id); if(!c) continue;
  if(c.img.startsWith('data:')) {
   const blob=await (await fetch(c.img)).blob(), path=`${current.me.id}/${crypto.randomUUID()}.jpg`;
   const {error}=await client.storage.from('poca-photos').upload(path,blob,{contentType:'image/jpeg',upsert:false}); if(error) throw error;
   uploaded.set(c.id,path);
  }
 }
 for(const c of draft.cards) if(uploaded.has(c.id)) c.img=uploaded.get(c.id);
 saveDraft();
 const selected=type=>draft[type].map(id=>draft.cards.find(c=>c.id===id)).filter(Boolean);
 await action('publish',{give:selected('give'),want:selected('want')}); toast('현장 목록에 반영했어요.');showTab('matches');
});
$('#leaveBtn').onclick=async()=>{if(await confirm('현장에서 나갈까요?','올린 포카와 대기 중인 거래가 현장에서 내려갑니다. 완료한 거래 내역과 내 사진은 남아요.')) void run(async()=>{await action('leave');draft.give=[];draft.want=[];saveDraft();showTab('register');toast('현장에서 나왔어요. 올린 포카도 내려갔어요.');});};
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.action==='here') here();
 if(b.dataset.pick && !busy) { const id=b.dataset.pick; if(!draft[mode].includes(id) && draft[mode].length>=30) return toast('각각 최대 30장까지 선택할 수 있어요.'); draft[mode]=draft[mode].includes(id)?draft[mode].filter(x=>x!==id):[...draft[mode],id];saveDraft();renderCards(); }
 if(b.dataset.edit && !busy) openEditor(b.dataset.edit);
 if(b.dataset.request!==undefined) {const m=current.matches[Number(b.dataset.request)];void run(async()=>{await action('request',{peerId:m.peerId,giveId:m.give.id,receiveId:m.receive.id});toast('상대방에게 완료 확인을 요청했어요.');});}
 if(b.dataset.confirmTrade) void (async()=>{if(await confirm('교환을 완료했나요?','확인하면 양쪽 등록 목록에서 교환한 포카가 내려가고 거래 내역에 남아요.'))void run(async()=>{await action('confirm',{id:b.dataset.confirmTrade});toast('교환 완료! 거래 내역에 저장했어요.');});})();
 if(b.dataset.cancelTrade) void run(async()=>{await action('cancel',{id:b.dataset.cancelTrade});toast('완료 요청을 취소했어요.');});
});
function openEditor(id) { editing=id; const c=draft.cards.find(c=>c.id===id); photoData=c?.img||''; $('#cardName').value=c?.name||'';$('#editorTitle').textContent=c?'이름 · 사진 수정':'포카 추가하기';$('#photo').value='';$('#editorError').textContent='';$('#preview').hidden=!c;$('#preview').src=c?imageURL(c):'';$('#editor').showModal(); }
$('#addBtn').onclick=()=>{if(!busy)openEditor();};$('#closeEditor').onclick=()=>$('#editor').close();$('#closeHere').onclick=()=>$('#hereDialog').close();
$('#photo').onchange=async()=>{
 const file=$('#photo').files[0];if(!file)return;photoLoading=true;$('#saveCard').disabled=true;$('#editorError').textContent='';
 try {
  if(file.size>20000000)throw new Error('20MB 이하의 사진을 선택해주세요.');
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'}), scale=Math.min(1,900/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  let quality=.82;photoData=canvas.toDataURL('image/jpeg',quality);while(photoData.length>600000&&quality>.3){quality-=.1;photoData=canvas.toDataURL('image/jpeg',quality);}if(photoData.length>600000)throw new Error('더 작은 사진을 선택해주세요.');
  $('#preview').src=photoData;$('#preview').hidden=false;
 }catch(e){$('#editorError').textContent=e.message.includes('사진')?e.message:'이 사진을 읽지 못했어요. JPG·PNG·WebP로 다시 선택해주세요.';}finally{photoLoading=false;$('#saveCard').disabled=false;}
};
$('#cardForm').onsubmit=e=>{e.preventDefault();if(photoLoading)return;const name=$('#cardName').value.trim();if(!name||!photoData){$('#editorError').textContent='사진과 포카 이름을 모두 입력해주세요.';return;}const card={id:editing||crypto.randomUUID(),name,img:photoData};if(editing)draft.cards=draft.cards.map(c=>c.id===editing?card:c);else{draft.cards.push(card);draft[mode].push(card.id);}const saved=saveDraft();$('#editor').close();renderCards();if(saved)toast('저장했어요. 현장 목록에는 올리기 버튼으로 반영해주세요.');};
try { $('#nick').value=localStorage.getItem('pocaNick')||'현장교환러'; }catch{}
render();
if(configured){
 try {
  client=createClient(url,publicKey);
  const {data:{session},error:sessionError}=await client.auth.getSession();if(sessionError)throw sessionError;
  if(!session){const {error}=await client.auth.signInAnonymously();if(error)throw error;}
  await refresh();
  setInterval(()=>{if(!document.hidden)void refresh();},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
 }catch(e){$('#connection').textContent='연결 실패';toast(`연결을 확인해주세요: ${e.message}`);}
}else{$('#connection').textContent='연결 준비 중';}
