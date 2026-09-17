import { createClient } from '@supabase/supabase-js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const url = import.meta.env.VITE_SUPABASE_URL, publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = /^https:\/\//.test(url || '') && !!publicKey && !url.includes('YOUR_PROJECT');
const emptyState = { me:null, catalog:[], matches:[], listings:[], trades:[], count:0 };
let current = emptyState, draft = { give:{}, want:{} }, mode = 'give';
let client, userId, channel, subscriptionKey, ready = false, busy = false, initialized = false;
let refreshSequence = 0, nicknameSequence = 0, nickTimer, hereIndex = 0;
let photoData = '', photoLoading = false, uploadedPhoto = '', importId = null;
let generatedName = '';
const photoURLs = new Map();
let photoRequest = false;
const normalize = value => value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const sum = items => Object.values(items).reduce((a,b) => a + Number(b), 0);
const cardById = id => current.catalog.find(c => c.id === id);
function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
let legacy = readLocal('pocaDraftV2', {cards:[]}).cards || [];
legacy = legacy.filter(c => typeof c.name === 'string' && typeof c.img === 'string' && !/^포카 [1-5]$/.test(c.name));
const imported = new Set(readLocal('pocaImportedCatalog', []));
function toast(message) {
 $('#toast').textContent = message; $('#toast').classList.add('show');
 clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4500);
}
function saveDraft() {
 try { localStorage.setItem('pocaBeta2Draft', JSON.stringify({ ...draft, owner:userId, revision:current.me?.revision ?? null })); }
 catch { toast('기기 저장 공간이 부족해요. 새로고침 전에 교환 목록을 올려주세요.'); }
}
function serverDraft(me) { return Object.fromEntries(['give','want'].map(type => [type, Object.fromEntries((me?.[type] || []).map(c => [c.id,c.qty]))])); }
function showTab(tab) {
 $$('nav button').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'); });
 $$('.section').forEach(s => s.classList.toggle('active-section', s.id === tab)); window.scrollTo({top:0});
}
function imageURL(card) {
 if (/^images\/poca_0[1-5]\.jpg$/.test(card.img) || card.img.startsWith('data:image/jpeg;base64,')) return card.img;
 return photoURLs.get(card.img)?.url || '';
}
function photo(card, lazy = true) { const src = imageURL(card); return src ? `<img src="${esc(src)}" alt="${esc(card.name)}" ${lazy?'loading="lazy"':''}>` : '<span class="photo-placeholder">사진 불러오는 중</span>'; }
function metadata(c) { return [c.event,c.kind,c.member].filter(Boolean).map(esc).join(' · '); }
function swap(give, receive) {
 return `<div class="swap"><div>${photo(give)}<small>내가 드려요</small><b>${esc(give.name)}</b><small>${give.qty || 1}장</small></div><span>⇄</span><div>${photo(receive)}<small>내가 받아요</small><b>${esc(receive.name)}</b><small>${receive.qty || 1}장</small></div></div>`;
}
function setFilter(id, field, label) {
 const select = $(id), value = select.value;
 const values = [...new Set(current.catalog.map(c => c[field]))].sort((a,b) => a.localeCompare(b,'ko'));
 select.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
 select.value = values.includes(value) ? value : '';
 $(`#${field === 'event' ? 'event' : field === 'kind' ? 'kind' : 'member'}Options`).innerHTML = values.map(v => `<option value="${esc(v)}"></option>`).join('');
}
function renderCatalog() {
 const query = normalize($('#search').value);
 const filtered = current.catalog.filter(c => (!$('#eventFilter').value || c.event === $('#eventFilter').value) && (!$('#kindFilter').value || c.kind === $('#kindFilter').value) && (!$('#memberFilter').value || c.member === $('#memberFilter').value) && normalize([c.name,c.event,c.kind,c.member].join(' ')).includes(query));
 $('#catalogCount').textContent = `전체 ${current.catalog.length}종 · 검색 결과 ${filtered.length}종`;
 $('#cards').innerHTML = filtered.map(c => `<article class="card ${draft[mode][c.id]?'selected':''}"><button class="pick" data-pick="${c.id}" aria-pressed="${!!draft[mode][c.id]}" ${busy?'disabled':''}>${photo(c)}<strong>${esc(c.name)}</strong><small>${metadata(c)}</small><span class="tags">${draft.give[c.id]?`<span>내놓아요 ${draft.give[c.id]}장</span>`:''}${draft.want[c.id]?`<span>구해요 ${draft.want[c.id]}장</span>`:''}</span><span>${draft[mode][c.id]?'✓ 선택됨':'선택하기'}</span></button></article>`).join('') || `<div class="empty">${ready?'검색 결과가 없어요. 다른 분류를 선택하거나 도감에 새 포카를 추가해주세요.':'도감을 불러오는 중이에요.'}</div>`;
 const total = sum(draft.give) + sum(draft.want);
 $('#selectionCount').textContent = total ? `내놓아요 ${sum(draft.give)}장 · 구해요 ${sum(draft.want)}장` : '도감에서 교환할 포카를 골라주세요';
 $('#addBtn').disabled = !ready || busy;
 $('#legacyPanel').hidden = !legacy.some(c => !imported.has(c.id));
 $('#legacyCards').innerHTML = legacy.filter(c => !imported.has(c.id)).map((c,i) => `<button data-import="${esc(c.id)}">${photo(c)}${esc(c.name)}<br>도감에 가져오기</button>`).join('');
}
function renderSelections() {
 for (const type of ['give','want']) {
  $(`#${type}N`).textContent = `${sum(draft[type])}장`;
  $(`#${type}List`).innerHTML = Object.entries(draft[type]).map(([id,qty]) => {
   const c = cardById(id); if (!c) return '';
   return `<article class="qty-card">${photo(c)}<div class="qty-info"><strong>${esc(c.name)}</strong><small>${metadata(c)}</small><div class="stepper"><button data-step="-1" data-kind="${type}" data-id="${id}" aria-label="${esc(c.name)} ${type==='give'?'내놓아요':'구해요'} 수량 줄이기" ${busy?'disabled':''}>−</button><input type="number" min="1" max="99" inputmode="numeric" value="${qty}" data-qty="${id}" data-kind="${type}" aria-label="${esc(c.name)} ${type==='give'?'내놓아요':'구해요'} 수량" ${busy?'disabled':''}><button data-step="1" data-kind="${type}" data-id="${id}" aria-label="${esc(c.name)} ${type==='give'?'내놓아요':'구해요'} 수량 늘리기" ${busy?'disabled':''}>＋</button><span>장</span><button class="remove" data-remove="${id}" data-kind="${type}" ${busy?'disabled':''}>선택 해제</button></div></div></article>`;
  }).join('') || `<div class="empty">${type==='give'?'내놓을':'원하는'} 포카를 도감에서 선택해주세요.</div>`;
 }
 $('#publishBtn').disabled = !ready || busy || !current.me?.day;
 $('#draftNote').textContent = !current.me?.day ? '날짜에 참여한 후 목록을 올려주세요. 원하는 포카도 도감에서 선택하고 수량을 정할 수 있어요.' : '수량 변경 후 아래 버튼으로 반영해주세요. 양쪽 목록을 비우고 올리면 게시를 철회할 수 있어요.';
}
function renderTrades() {
 const me = current.me;
 const quantities = new Map($$('[data-match-key]').map(input => [input.dataset.matchKey,input.value]));
 $('#badge').textContent = current.matches.length; $('#matchCount').textContent = current.matches.length;
 $('#matchDay').textContent = me?.day ? `${me.day} · ${current.count}명 참여 중 · 같은 날짜끼리 매칭해요` : '내 교환에서 날짜에 먼저 참여해주세요.';
 $('#pendingList').innerHTML = current.trades.filter(t => t.status === 'pending').map(t => {
  const sender = t.from === me?.id;
  return `<article class="match"><span class="pill">${sender?'상대 확인 대기':'완료 확인 요청'}</span><h2>${esc(sender?t.toNick:t.fromNick)}님과 ${t.quantity || 1}장씩 교환</h2>${swap(sender?t.give:t.receive,sender?t.receive:t.give)}<div class="actions">${sender?'':`<button data-confirm-trade="${t.id}">교환 완료 확인</button>`}<button data-cancel-trade="${t.id}">${sender?'요청 취소':'아직 교환 안 했어요'}</button></div></article>`;
 }).join('');
 $('#matchList').innerHTML = current.matches.map((m,i) => {
  const key = `${m.peerId}:${m.give.id}:${m.receive.id}`;
  const quantity = Math.max(1,Math.min(m.maxQty,Number(quantities.get(key)) || 1));
  return `<article class="match"><div class="top"><h2>${esc(m.nickname)}님</h2><span class="pill">최대 ${m.maxQty}장씩</span></div>${swap(m.give,m.receive)}<label class="trade-quantity">이번에 교환할 수량<input id="tradeQty${i}" data-match-key="${key}" type="number" min="1" max="${m.maxQty}" value="${quantity}" inputmode="numeric">장씩</label><div class="actions"><button data-request="${i}" ${busy?'disabled':''}>교환 완료 요청</button><button data-action="here">여기 있어요</button></div></article>`;
 }).join('') || '<div class="empty">아직 서로 맞는 포카가 없어요.<br>날짜에 참여한 뒤 양쪽 포카를 도감에서 골라 올려주세요.</div>';
 $('#listingList').innerHTML = current.listings.filter(p => p.give.length || p.want.length).map(p => `<article class="match"><h2>${esc(p.nickname)}님</h2><p><b>내놓아요</b> ${p.give.map(c => `${esc(c.name)} ${c.qty}장`).join(', ') || '없음'}</p><p><b>구해요</b> ${p.want.map(c => `${esc(c.name)} ${c.qty}장`).join(', ') || '없음'}</p></article>`).join('') || '<div class="empty">아직 다른 사람이 올린 포카가 없어요.</div>';
 $('#historyList').innerHTML = current.trades.filter(t => t.status === 'completed').sort((a,b) => new Date(b.completedAt)-new Date(a.completedAt)).map(t => {
  const sender = t.from === userId;
  return `<article class="match"><span class="pill">교환 완료${t.legacy?' · 1차 베타':''}</span><h2>${esc(sender?t.toNick:t.fromNick)}님과 교환</h2>${swap(sender?t.give:t.receive,sender?t.receive:t.give)}<p class="muted">${esc(t.room)} · ${esc(new Date(t.completedAt).toLocaleString('ko-KR'))}</p></article>`;
 }).join('') || '<div class="empty">아직 완료한 거래가 없어요.</div>';
}
function renderHere() {
 const cards = current.me?.give || [];
 hereIndex = cards.length ? (hereIndex + cards.length) % cards.length : 0;
 $('#bigNick').textContent = current.me?.nickname || '';
 $('#hereRoom').textContent = current.me?.day || '';
 // Keep four-character nicknames huge while fitting longer names on at most two lines.
 $('#bigNick').style.fontSize = `clamp(3.4rem, ${Math.min(18, 72 / Math.min((current.me?.nickname || '').length || 1, 5))}vw, 8rem)`;
 $('#herePhoto').innerHTML = cards.length ? photo(cards[hereIndex],false) : '<div class="empty">현재 올린 포카가 없어요.</div>';
 $('#hereName').textContent = cards[hereIndex]?.name || '';
 $('#hereQty').textContent = cards.length ? `교환 가능 ${cards[hereIndex].qty}장` : '';
 $('#herePager').textContent = cards.length ? `${hereIndex+1} / ${cards.length}` : '';
 $('#prevCard').disabled = $('#nextCard').disabled = cards.length < 2;
}
function render() {
 const joined = !!current.me?.day;
 $('#joinForm').hidden = joined; $('#venue').hidden = !joined;
 $('#joinBtn').disabled = !ready || busy; $('#leaveBtn').disabled = busy;
 $('#venueName').textContent = current.me?.day || ''; $('#myNickname').textContent = `${current.me?.nickname || ''}님으로 참여 중`;
 $('#count').textContent = `${current.count}명 참여 중`;
 renderCatalog(); renderSelections(); renderTrades();
 if ($('#hereDialog').open) renderHere();
}
async function loadPhotos() {
 if (!client || photoRequest) return;
 const cards = [...current.catalog, ...current.trades.flatMap(t => [t.give,t.receive]), ...legacy];
 const paths = [...new Set(cards.map(c => c.img).filter(p => p && !p.startsWith('images/') && !p.startsWith('data:') && (!photoURLs.has(p) || photoURLs.get(p).expires < Date.now())))];
 if (!paths.length) return;
 photoRequest = true;
 try {
  for (let i=0; i<paths.length; i+=100) {
   const {data,error} = await client.storage.from('poca-photos').createSignedUrls(paths.slice(i,i+100),3600);
   if (!error) for (const p of data) if (p.signedUrl) photoURLs.set(p.path,{url:p.signedUrl,expires:Date.now()+3300000});
  }
  render();
 } finally { photoRequest = false; }
}
function apply(next) {
 const previous = current.me;
 if (!initialized) {
  const saved = readLocal('pocaBeta2Draft',null);
  draft = saved?.owner === userId && saved.revision === (next.me?.revision ?? null) ? {give:saved.give || {},want:saved.want || {}} : serverDraft(next.me);
  initialized = true;
  if (next.me) $('#nick').value = next.me.nickname;
 } else if ((previous?.revision ?? null) !== (next.me?.revision ?? null)) {
  draft = serverDraft(next.me);
 }
 current = next;
 for (const type of ['give','want']) for (const [id,qty] of Object.entries(draft[type])) if (!cardById(id) || !Number.isInteger(qty) || qty<1 || qty>99) delete draft[type][id];
 setFilter('#eventFilter','event','전체 행사'); setFilter('#kindFilter','kind','전체 종류'); setFilter('#memberFilter','member','전체 멤버');
 saveDraft(); render(); void loadPhotos(); subscribe();
}
function subscribe() {
 if (!client || !userId) return;
 const key = `${userId}:${current.me?.day || ''}`;
 if (subscriptionKey === key) return;
 if (channel) void client.removeChannel(channel);
 subscriptionKey = key;
 channel = client.channel(`poca2-${crypto.randomUUID()}`).on('postgres_changes',{event:'*',schema:'public',table:'poca2_updates'},() => void refresh()).subscribe(status => {
  if (status === 'SUBSCRIBED') { $('#connection').textContent='● 실시간 연결'; void refresh(); }
  else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') $('#connection').textContent='연결 재시도 중';
 });
}
async function refresh() {
 if (!client || !userId) return;
 const seq = ++refreshSequence;
 const {data,error} = await client.rpc('poca2_state');
 if (seq !== refreshSequence) return;
 if (error) { $('#connection').textContent='연결 재시도 중'; return; }
 ready = true; apply(data); $('#connection').textContent='● 연결됨';
}
async function action(name,input = {}) {
 const keepSelection = name === 'join' && !current.me?.day ? structuredClone(draft) : null;
 ++refreshSequence;
 const {data,error} = await client.rpc('poca2_action',{action:name,input});
 if (error) { await refresh(); throw error; }
 ++refreshSequence; apply(data);
 if (keepSelection) { draft = keepSelection; saveDraft(); render(); }
 return data;
}
async function run(task) {
 if (busy || !ready) return;
 busy = true; render();
 try { await task(); } catch(e) { toast(e.message || '처리하지 못했어요. 다시 시도해주세요.'); }
 finally { busy = false; render(); }
}
function confirm(title,text) {
 $('#confirmTitle').textContent=title; $('#confirmText').textContent=text; $('#confirmDialog').showModal();
 return new Promise(resolve => {
  const done = result => { $('#confirmDialog').close(); resolve(result); };
  $('#confirmNo').onclick = () => done(false); $('#confirmYes').onclick = () => done(true);
  $('#confirmDialog').oncancel = e => { e.preventDefault(); done(false); };
 });
}
function choose(type) { mode=type; $$('[data-mode]').forEach(b=>b.classList.toggle('on',b.dataset.mode===mode)); renderCatalog(); showTab('catalog'); }
function changeQty(type,id,value) {
 if (busy) return;
 const quantity = Math.max(1,Math.min(99,Math.floor(Number(value) || 1)));
 draft[type][id] = quantity; saveDraft(); renderCatalog(); renderSelections();
}
async function checkNickname() {
 const sequence=++nicknameSequence, nickname=$('#nick').value.trim();
 if (!ready || !nickname) return;
 const {data,error}=await client.rpc('poca2_action',{action:'nickname',input:{nickname}});
 if (sequence!==nicknameSequence || nickname!==$('#nick').value.trim()) return;
 $('#nickStatus').textContent=error?'참여할 때 닉네임을 다시 확인해요.':data.available?'✓ 사용 가능한 닉네임이에요.':'이미 사용 중인 닉네임이에요.';
 $('#nickStatus').className=data?.available?'muted nickname-ok':'muted nickname-error';
}
$$('nav button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$$('[data-mode]').forEach(b=>b.onclick=()=>choose(b.dataset.mode));
$('#goRegister').onclick=()=>showTab('register');
$('#search').oninput=renderCatalog;
for (const id of ['eventFilter','kindFilter','memberFilter']) $(`#${id}`).onchange=renderCatalog;
$('#nick').oninput=()=>{ ++nicknameSequence; clearTimeout(nickTimer); $('#nickStatus').textContent='확인 중…'; nickTimer=setTimeout(checkNickname,350); };
$('#joinForm').onsubmit=e=>{ e.preventDefault(); void run(async()=>{ await action('join',{nickname:$('#nick').value.trim(),day:$('#day').value}); try{localStorage.setItem('pocaNick',$('#nick').value.trim());}catch{} toast('선택한 날짜로 참여했어요. 포카 목록을 올려주세요.'); }); };
$('#publishBtn').onclick=()=>void run(async()=>{ const selection=type=>Object.entries(draft[type]).map(([id,qty])=>({id,qty})); await action('publish',{give:selection('give'),want:selection('want'),revision:current.me.revision}); showTab('matches'); toast('교환 목록에 반영했어요.'); });
$('#leaveBtn').onclick=async()=>{if(await confirm('현장에서 나갈까요?','올린 포카와 완료 대기 요청을 철회해요. 공용 도감과 거래 내역은 남아요.')) void run(async()=>{await action('leave');toast('현장에서 나왔어요. 도감은 그대로 남아 있어요.');});};
document.addEventListener('click',e=>{
 const b=e.target.closest('button'); if(!b)return;
 if(b.dataset.choose)choose(b.dataset.choose);
 if(b.dataset.action==='here') { if(!current.me?.day)return toast('교환 날짜에 먼저 참여해주세요.'); hereIndex=0;renderHere();$('#hereDialog').showModal(); }
 if(b.dataset.pick && !busy) {const id=b.dataset.pick;if(draft[mode][id])delete draft[mode][id];else{if(Object.keys(draft[mode]).length>=30)return toast('각각 최대 30종까지 선택할 수 있어요.');draft[mode][id]=1;}saveDraft();renderCatalog();renderSelections();}
 if(b.dataset.step)changeQty(b.dataset.kind,b.dataset.id,(draft[b.dataset.kind][b.dataset.id]||1)+Number(b.dataset.step));
 if(b.dataset.remove && !busy){delete draft[b.dataset.kind][b.dataset.remove];saveDraft();renderCatalog();renderSelections();}
 if(b.dataset.import && !busy)openEditor(legacy.find(c=>c.id===b.dataset.import));
 if(b.dataset.request!==undefined && !busy){const i=Number(b.dataset.request),m=current.matches[i],quantity=Number($(`#tradeQty${i}`).value);if(!Number.isInteger(quantity)||quantity<1||quantity>m.maxQty)return toast('교환 가능한 수량을 입력해주세요.');void run(async()=>{await action('request',{peerId:m.peerId,giveId:m.give.id,receiveId:m.receive.id,quantity});toast('상대방에게 완료 확인을 요청했어요.');});}
 if(b.dataset.confirmTrade)void(async()=>{if(await confirm('교환을 완료했나요?','요청한 장수만큼 양쪽의 내놓아요·구해요 수량이 줄어들고 거래 내역에 남아요.'))void run(async()=>{await action('confirm',{id:b.dataset.confirmTrade});toast('교환 완료! 남은 수량과 거래 내역을 반영했어요.');});})();
 if(b.dataset.cancelTrade)void run(async()=>{await action('cancel',{id:b.dataset.cancelTrade});toast('완료 요청을 취소했어요.');});
});
document.addEventListener('change',e=>{if(e.target.dataset.qty)changeQty(e.target.dataset.kind,e.target.dataset.qty,e.target.value);});
$('#prevCard').onclick=()=>{hereIndex--;renderHere();};$('#nextCard').onclick=()=>{hereIndex++;renderHere();};$('#closeHere').onclick=()=>$('#hereDialog').close();
$('#hereDialog').addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){hereIndex--;renderHere();}if(e.key==='ArrowRight'){hereIndex++;renderHere();}});
let touchStart;
$('#herePhoto').addEventListener('touchstart',e=>{touchStart=e.changedTouches[0].clientX;},{passive:true});
$('#herePhoto').addEventListener('touchend',e=>{const delta=e.changedTouches[0].clientX-touchStart;if(Math.abs(delta)>45){hereIndex+=delta<0?1:-1;renderHere();}},{passive:true});
function openEditor(old) {
 importId=old?.id || null;photoData=old?.img || '';uploadedPhoto='';generatedName='';$('#cardForm').reset();$('#editorError').textContent='';
 $('#cardName').value=old?.name || '';$('#preview').hidden=!old;$('#preview').src=old?imageURL(old):'';$('#editor').showModal();
}
$('#addBtn').onclick=()=>{if(ready&&!busy)openEditor();};$('#closeEditor').onclick=()=>{if(!photoLoading&&!busy)$('#editor').close();};
$('#editor').addEventListener('cancel',e=>{if(photoLoading||busy)e.preventDefault();});
for(const id of ['catalogKind','catalogMember']) $(`#${id}`).addEventListener('input',()=>{
 if(!$('#cardName').value.trim() || $('#cardName').value === generatedName) {
  generatedName=[$('#catalogKind').value.trim(),$('#catalogMember').value.trim()].filter(Boolean).join(' ');
  $('#cardName').value=generatedName;
 }
});
$('#photo').onchange=async()=>{
 const file=$('#photo').files[0];if(!file)return;photoLoading=true;photoData='';uploadedPhoto='';$('#preview').hidden=true;$('#saveCard').disabled=true;$('#editorError').textContent='';
 try{
  if(file.size>20000000)throw new Error('20MB 이하의 사진을 선택해주세요.');
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'}),scale=Math.min(1,900/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  let quality=.82;photoData=canvas.toDataURL('image/jpeg',quality);while(photoData.length>600000&&quality>.3){quality-=.1;photoData=canvas.toDataURL('image/jpeg',quality);}if(photoData.length>600000){photoData='';throw new Error('더 작은 사진을 선택해주세요.');}
  $('#preview').src=photoData;$('#preview').hidden=false;
 }catch(e){$('#editorError').textContent=e.message.includes('사진')?e.message:'사진을 읽지 못했어요. JPG·PNG·WebP로 선택해주세요.';}
 finally{photoLoading=false;$('#saveCard').disabled=false;}
};
$('#cardForm').onsubmit=e=>{
 e.preventDefault();if(photoLoading||busy||!ready)return;
 const info={event:$('#catalogEvent').value.trim(),kind:$('#catalogKind').value.trim(),member:$('#catalogMember').value.trim(),name:$('#cardName').value.trim()};
 if(!photoData||Object.values(info).some(v=>!v)){ $('#editorError').textContent='사진과 도감 정보를 모두 입력해주세요.';return;}
 void run(async()=>{
  $('#saveCard').disabled=true;$('#editorError').textContent='';
  try{
   if(!uploadedPhoto){
    if(photoData.startsWith(`${userId}/`))uploadedPhoto=photoData;
    else{
     const source=/^(data:image\/jpeg;base64,|images\/poca_0[1-5]\.jpg$)/.test(photoData)?photoData:photoURLs.get(photoData)?.url;
     if(!source)throw new Error('기존 사진을 다시 선택해주세요.');
     const response=await fetch(source);if(!response.ok)throw new Error('사진을 가져오지 못했어요.');const blob=await response.blob();
     const path=`${userId}/${crypto.randomUUID()}.jpg`;const {error}=await client.storage.from('poca-photos').upload(path,blob,{contentType:'image/jpeg',upsert:false});if(error)throw error;uploadedPhoto=path;
    }
   }
   const result=await action('catalog_add',{...info,img:uploadedPhoto});
   if(importId){imported.add(importId);try{localStorage.setItem('pocaImportedCatalog',JSON.stringify([...imported]));}catch{}}
   if(Object.keys(draft[mode]).length<30)draft[mode][result.addedId]=1;
   saveDraft();$('#editor').close();$('#search').value='';$('#eventFilter').value='';$('#kindFilter').value='';$('#memberFilter').value='';render();toast('공용 도감에 저장했어요. 사진과 이름은 계속 남아요.');
  }catch(error){$('#editorError').textContent=error.message;}
  finally{$('#saveCard').disabled=false;}
 });
};
const now=new Date();$('#day').value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
try{$('#nick').value=localStorage.getItem('pocaNick')||'';}catch{}
render();
if(configured){
 try{
  client=createClient(url,publicKey);const {data:{session},error}=await client.auth.getSession();if(error)throw error;
  let active=session;if(!active){const signed=await client.auth.signInAnonymously();if(signed.error)throw signed.error;active=signed.data.session;}
  userId=active.user.id;await refresh();if(!ready)throw new Error('2차 베타 데이터베이스 연결을 확인해주세요.');
  setInterval(()=>{if(!document.hidden)void refresh();},15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
 }catch(error){$('#connection').textContent='연결 실패';toast(error.message);}
}else{$('#connection').textContent='연결 준비 중';$('#catalogCount').textContent='Supabase 연결 설정이 필요해요.';}
