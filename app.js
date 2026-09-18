import { setupChat } from './chat.js';
import { createClient } from '@supabase/supabase-js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const url = import.meta.env.VITE_SUPABASE_URL, publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = /^https:\/\//.test(url || '') && !!publicKey && !url.includes('YOUR_PROJECT');
const emptyState = { me:null, catalog:[], matches:[], listings:[], trades:[], count:0 };
let chat;
let recordSection="listings",recordPage=0,recordQuery="",recordRequest=0;
let sessionTimer;
let participants=[],participantRequest=0;
let notifiedOwner='',seenMatches=new Set(),alertKey='',expiryRefresh=0;
let current = emptyState, draft = { give:{}, want:{}, conditions:{} }, mode = 'give';
let client, userId, channel, subscriptionKey, ready = false, busy = false, initialized = false;
let refreshSequence = 0, hereIndex = 0;
let photoData = '', photoLoading = false, uploadedPhoto = '';
let generatedName = '';
let editingId=null,lastDeletedId=null;
let catalogColumns=Number(readLocal('pocaCatalogColumns',3));if(![3,4,5,6].includes(catalogColumns))catalogColumns=3;
const MEMBERS=['원이','리브','미나미','메이','제나'];
let activeOffer='', editorMembers=[], filterMember='';
const ruleFor=id=>draft.conditions[id] ||= {ids:[],members:[],any:false};
function syncWanted(){ draft.want=Object.fromEntries((draft.conditions[activeOffer]?.ids || []).map(id=>[id,1])); }

const photoURLs = new Map();
let photoRequest = false;
const normalize = value => value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const sum = items => Object.values(items).reduce((a,b) => a + Number(b), 0);
const cardById = id => current.catalog.find(c => c.id === id);
function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function toast(message) {
 $('#toast').textContent = message; $('#toast').classList.add('show');
 clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4500);
}
function saveDraft() {
 try { localStorage.setItem('pocaBeta2Draft', JSON.stringify({ ...draft, owner:userId, revision:current.me?.revision ?? null, account:current.account?.id ?? null })); }
 catch { toast('기기 저장 공간이 부족해요. 새로고침 전에 교환 목록을 올려주세요.'); }
}
function serverDraft(me) { return {give:Object.fromEntries((me?.give || []).map(c=>[c.id,c.qty])),want:{},conditions:structuredClone(me?.conditions || {})}; }
function showTab(tab) {
 $$('nav button').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'); });
 $$('.section').forEach(s => s.classList.toggle('active-section', s.id === tab)); window.scrollTo({top:0});
}
function imageURL(card) {
 if (/^images\/poca_0[1-5]\.jpg$/.test(card.img) || card.img.startsWith('data:image/jpeg;base64,')) return card.img;
 return photoURLs.get(card.img)?.url || '';
}
function photo(card, lazy = true) { const src = imageURL(card); return src ? `<img src="${esc(src)}" alt="${esc(card.name)}" ${lazy?'loading="lazy"':''}>` : '<span class="photo-placeholder">사진 불러오는 중</span>'; }
function metadata(c) { return [c.event,c.release,c.kind,c.member].filter(Boolean).map(esc).join(' · '); }
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
 $('#cards').style.setProperty('--catalog-columns',catalogColumns);$('#catalogColumns').value=String(catalogColumns);
 $('#undoCatalogDelete').hidden=!lastDeletedId || !current.account;
 if(!draft.give[activeOffer]) activeOffer=Object.keys(draft.give)[0] || '';
 syncWanted();
 $('#offerPickerLabel').hidden=mode!=='want';
 $('#offerPicker').innerHTML=Object.keys(draft.give).map(id=>`<option value="${id}">${esc(cardById(id)?.name)}</option>`).join('');$('#offerPicker').value=activeOffer;
 $('#catalogMemberButtons').innerHTML=['전체',...MEMBERS,'단체'].map(m=>`<button data-filter-member="${m==='전체'?'':m}" aria-pressed="${filterMember===(m==='전체'?'':m)}">${m}</button>`).join('');
 const filtered = current.catalog.filter(c => (!$('#eventFilter').value || c.event === $('#eventFilter').value) && (!$('#kindFilter').value || c.kind === $('#kindFilter').value) && (!$('#memberFilter').value || c.member === $('#memberFilter').value || c.members?.includes($('#memberFilter').value)) && (!filterMember || (filterMember==='단체' ? c.members?.length===5 : c.members?.includes(filterMember))) && normalize([c.name,c.event,c.release,c.kind,c.member].join(' ')).includes(query));
 $('#catalogCount').textContent = `전체 ${current.catalog.length}종 · 검색 결과 ${filtered.length}종`;
 const renderCard = c => `<article class="card ${draft[mode][c.id]?'selected':''}"><button class="pick" data-pick="${c.id}" aria-pressed="${!!draft[mode][c.id]}" ${busy?'disabled':''}>${photo(c)}<strong>${esc(c.name)}</strong><small>${metadata(c)}</small><span class="tags">${draft.give[c.id]?`<span>내놓아요 ${draft.give[c.id]}장</span>`:''}${draft.want[c.id]?`<span>교환 후보</span>`:''}</span><span>${draft[mode][c.id]?'✓ 선택됨':'선택하기'}</span></button>${current.account?`<div class="catalog-actions"><button data-edit-card="${c.id}">수정</button><button data-delete-card="${c.id}">삭제</button></div>`:''}</article>`;
 const groups=filtered.reduce((groups,c)=>{(groups[c.event || '기타'] ||= []).push(c);return groups;},Object.create(null));
 $('#cards').innerHTML=Object.entries(groups).map(([event,cards])=>`<section class="event-group"><h2>${esc(event)} <small>${cards.length}종</small></h2><div class="event-grid">${cards.map(renderCard).join('')}</div></section>`).join('') || `<div class="empty">${ready?'검색 결과가 없어요. 다른 분류를 선택해주세요.':'도감을 불러오는 중이에요.'}</div>`;
 const candidateCount=Object.values(draft.conditions).reduce((n,r)=>n+r.ids.length,0);
 const total = sum(draft.give) + candidateCount;
 $('#selectionCount').textContent = total ? `내놓아요 ${sum(draft.give)}장 · 선택 후보 ${candidateCount}개` : '도감에서 교환할 포카를 골라주세요';
 $('#addBtn').hidden = !current.account; $('#addBtn').disabled = !ready || busy;
}
function renderSelections() {
 $('#giveN').textContent=`${sum(draft.give)}장`;
 $('#giveList').innerHTML=Object.entries(draft.give).map(([id,qty])=>{const c=cardById(id);if(!c)return '';return `<article class="qty-card">${photo(c)}<div class="qty-info"><strong>${esc(c.name)}</strong><small>${metadata(c)}</small><b>${qty}장 보유</b><div class="stepper"><button data-step="-1" data-kind="give" data-id="${id}" aria-label="수량 줄이기">−</button><input type="number" min="1" max="99" value="${qty}" data-qty="${id}" data-kind="give" aria-label="보유수량"><button data-step="1" data-kind="give" data-id="${id}" aria-label="수량 늘리기">＋</button><button class="remove" data-remove="${id}" data-kind="give">선택 해제</button></div></div></article>`;}).join('') || '<div class="empty">보유 포카를 도감에서 선택해주세요.</div>';
 $('#wantN').textContent='';
 $('#resetGive').disabled=busy || !Object.keys(draft.give).length && !current.me?.give?.length;
 $('#resetWant').disabled=busy || ![...Object.values(draft.conditions),...Object.values(current.me?.conditions || {})].some(r=>r.any || r.members?.length || r.ids?.length);
 $('#wantList').innerHTML=Object.keys(draft.give).map(id=>{const r=ruleFor(id);return `<article class="panel"><h2>${esc(cardById(id)?.name)} ↔ 교환 후보</h2><div class="member-buttons"><button data-any="${id}" aria-pressed="${r.any}">아무거나 가능</button>${MEMBERS.map(m=>`<button data-want-member="${m}" data-offer="${id}" aria-pressed="${r.members.includes(m)}">${m} 모든 종류</button>`).join('')}</div><div class="wanted-photos">${r.ids.map(cid=>{const c=cardById(cid);return c?`<article class="wanted-photo">${photo(c)}<strong>${esc(c.name)}</strong><button class="text-button" data-remove-candidate="${cid}" data-offer="${id}" ${busy?'disabled':''}>선택 해제</button></article>`:'';}).join('') || '<p class="muted">특정 포카 선택 없음</p>'}</div><button class="text-button" data-offer-select="${id}">도감에서 후보 복수 선택</button></article>`;}).join('') || '<div class="empty">보유 포카마다 원하는 포카를 여러 개 고를 수 있어요.</div>';
 $('#publishBtn').disabled=!ready || busy || !current.me?.day || !current.account;
 $('#draftNote').textContent='후보 중 하나와 교환하면 보유수량만 1장 줄어들어요. 수정 후 목록에 반영해주세요.';
}
function renderTrades() {
 const me=current.me, owner=current.account?.id;
 $('#badge').textContent=current.matches.length;$('#matchCount').textContent=current.matches.filter(m=>m.mutual).length;
 $('#matchDay').textContent=me?.day?`${me.day} · ${me.region || '미지정'} · ${current.count}명 참여 중`:'내 교환에서 날짜에 먼저 참여해주세요.';
 $('#pendingList').innerHTML=current.trades.filter(t=>['awaiting','reserved','pending'].includes(t.status)).map(t=>{
 const sender=t.from===owner, completionBy=t.completionBy || t.from;
 const label=t.status==='awaiting'?'약속 요청':t.status==='reserved'?'약속 중':'완료 확인 대기';
 return `<article class="match"><span class="pill">${label}</span><h2>${esc(sender?t.toNick:t.fromNick)}님 · #${esc(sender?t.toNo:t.fromNo)}</h2>${swap(sender?t.give:t.receive,sender?t.receive:t.give)}<p class="muted"><span data-expires="${esc(t.expiresAt || '')}"></span></p><div class="actions">${t.status==='awaiting'&&!sender?`<button data-trade-action="accept" data-trade-id="${t.id}">약속 수락</button>`:''}${t.status==='reserved'?`<button data-trade-action="complete" data-trade-id="${t.id}">교환 완료</button><button data-here-card="${sender?t.give.id:t.receive.id}">여기 있어요</button>`:''}${['reserved','pending'].includes(t.status)?`<button data-trade-action="extend" data-trade-id="${t.id}" ${t.extended?'disabled':''}>${t.extended?'연장 완료':'+15분 연장 (1회)'}</button>`:''}${t.status==='pending'&&completionBy!==owner?`<button data-confirm-trade="${t.id}">교환 완료 확인</button>`:''}<button data-chat-peer="${sender?t.to:t.from}" data-chat-give="${sender?t.give.id:t.receive.id}" data-chat-receive="${sender?t.receive.id:t.give.id}">1:1 채팅</button><button data-cancel-trade="${t.id}">약속 취소</button></div></article>`;
 }).join('');
 $('#matchList').innerHTML=current.matches.map((m,i)=>`${i===0 || current.matches[i-1].mutual!==m.mutual?`<h2>${m.mutual?'💕 맞교환':'일반 교환 후보'}</h2>`:''}<article class="match" data-match-key="${esc(matchKey(m))}"><div class="top"><h2>${esc(m.nickname)}님 · #${esc(m.exchangeNo)}</h2><span class="pill">${m.mutual?'💕 맞교환':'일반 교환 후보'}</span></div>${swap({...m.give,qty:1},{...m.receive,qty:1})}<p class="muted">${m.mutual?'양쪽 교환 조건이 맞아요.':'한쪽 조건만 맞아요. 상대방이 수락하면 약속해요.'}</p><div class="actions"><button data-request="${i}" ${busy?'disabled':''}>1장 교환 약속 요청</button><button data-chat-peer="${m.peerId}" data-chat-give="${m.give.id}" data-chat-receive="${m.receive.id}">1:1 채팅</button><button data-here-card="${m.give.id}">여기 있어요</button></div></article>`).join('') || '<div class="empty">아직 교환 후보가 없어요.</div>';
 $('#listingList').innerHTML=current.listings.filter(p=>p.give.length).map(p=>`<article class="match"><h2>${esc(p.nickname)}님 · #${esc(p.exchangeNo)}</h2><div class="listed-cards">${p.give.map(c=>`<article class="listed-card">${photo(c)}<div><strong>${esc(c.name)}</strong><small>${metadata(c)}</small><span>교환 가능 ${c.available ?? 0}장</span>${c.qty-c.available>0?`<span class="muted">약속 중 ${c.qty-c.available}장</span>`:''}</div></article>`).join('')}</div></article>`).join('') || '<div class="empty">아직 다른 사람이 올린 포카가 없어요.</div>';
 $('#historyList').innerHTML=current.trades.filter(t=>t.status==='completed').sort((a,b)=>new Date(b.completedAt)-new Date(a.completedAt)).map(t=>{const sender=t.from===owner;return `<article class="match"><span class="pill">교환 완료</span><h2>${esc(sender?t.toNick:t.fromNick)}님과 교환</h2>${swap(sender?t.give:t.receive,sender?t.receive:t.give)}<p class="muted">${esc(t.room)} · ${esc(new Date(t.completedAt).toLocaleString('ko-KR'))}</p></article>`;}).join('') || '<div class="empty">아직 완료한 거래가 없어요.</div>';
}
function renderHere() {
 const cards = current.me?.give || [];
 hereIndex = cards.length ? (hereIndex + cards.length) % cards.length : 0;
 $('#bigNick').textContent = current.me?.nickname || '';
 $('#hereRoom').textContent = [current.me?.day,current.me?.region].filter(Boolean).join(' · ');
 $('#hereNumber').textContent=current.me?.exchange_no ? `교환번호 #${current.me.exchange_no}` : '';
 $('#hereDialog').style.background='#000';$('#hereDialog').style.setProperty('--here-ink','#fff');$('#hereDialog').style.setProperty('--here-outline','#000');
 // Keep four-character nicknames huge while fitting longer names on at most two lines.
 $('#bigNick').style.fontSize = `clamp(3.4rem, ${Math.min(18, 72 / Math.min((current.me?.nickname || '').length || 1, 5))}vw, 8rem)`;
 $('#herePhoto').innerHTML = cards.length ? photo(cards[hereIndex],false) : '<div class="empty">현재 올린 포카가 없어요.</div>';
 $('#hereName').textContent = cards[hereIndex]?.name || '';
 $('#hereQty').textContent = cards.length ? `교환 가능 ${cards[hereIndex].qty}장` : '';
 $('#herePager').textContent = cards.length ? `${hereIndex+1} / ${cards.length}` : '';
 $('#prevCard').disabled = $('#nextCard').disabled = cards.length < 2;
}
function render() {
 if($('#editor').open)return;
 const joined = !!current.me?.day;
 $('#loginPanel').hidden=!!current.account;$('#accountPanel').hidden=!current.account;
 $('#accountName').textContent=current.account?`${current.account.nickname}님`:'';
 $('#loginBtn').disabled=$('#signupBtn').disabled=busy || !ready;
 $('#nick').readOnly=true;$('#nick').value=current.account?.nickname || '';
 $('#logoutBtn').disabled=busy;$('#adminParticipants').hidden=!current.admin;$('#adminRecords').hidden=!current.admin;
 if(!current.admin){++recordRequest;$('#recordsList').replaceChildren();if($('#recordsDialog').open)$('#recordsDialog').close();}
 if(!current.admin){participants=[];++participantRequest;$('#participantList').replaceChildren();if($('#participantsDialog').open)$('#participantsDialog').close();}
 $('#joinForm').hidden = joined; $('#venue').hidden = !joined;
 $('#joinBtn').disabled = !ready || busy || !current.account; $('#leaveBtn').disabled = busy;
 $('#venueName').textContent = [current.me?.day,current.me?.region].filter(Boolean).join(' · ');
 $('#regionButtons').innerHTML=(current.regions || []).map(r=>`<button type="button" data-region="${esc(r)}" aria-pressed="${$('#region').value===r}">${esc(r)}</button>`).join(''); $('#myNickname').textContent = `${current.me?.nickname || ''}님으로 참여 중`;
 $('#count').textContent = `${current.count}명 참여 중`;
 renderCatalog(); renderSelections(); renderTrades();updateCountdowns();
 if ($('#hereDialog').open) renderHere();
}
async function loadPhotos() {
 if (!client || photoRequest) return;
 const cards = [...current.catalog, ...current.listings.flatMap(p=>p.give), ...current.trades.flatMap(t => [t.give,t.receive])];
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
 if(next.account && next.sessionExpiresAt && Date.parse(next.sessionExpiresAt)<=Date.now())next={...next,account:null,admin:false,me:null,matches:[],listings:[],trades:[],count:0};
 clearTimeout(sessionTimer);
 if(next.account && next.sessionExpiresAt)sessionTimer=setTimeout(expireSession,Math.max(0,Date.parse(next.sessionExpiresAt)-Date.now()));
 if(current.account && !next.account){for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();$('#loginPin').value='';toast('로그아웃됐어요. 다시 로그인해주세요.');}

 const previous = current.me;
 if (initialized && current.account?.id !== next.account?.id) initialized=false;
 if (!initialized) {
  const saved = readLocal('pocaBeta2Draft',null);
  draft = saved?.owner === userId && saved.account === (next.account?.id ?? null) && saved.revision === (next.me?.revision ?? null) ? {give:saved.give || {},want:{},conditions:saved.conditions || {}} : serverDraft(next.me);
  initialized = true;
  if (next.me) $('#nick').value = next.me.nickname;
 } else if ((previous?.revision ?? null) !== (next.me?.revision ?? null)) {
  draft = serverDraft(next.me);
 }
 current = next; draft.conditions ||= {};for(const [id,r] of Object.entries(draft.conditions)){if(!current.catalog.some(c=>c.id===id))delete draft.conditions[id];else r.ids=r.ids.filter(cid=>current.catalog.some(c=>c.id===cid));} if(!draft.give[activeOffer])activeOffer=Object.keys(draft.give)[0] || ''; syncWanted();
 for (const type of ['give','want']) for (const [id,qty] of Object.entries(draft[type])) if (!cardById(id) || !Number.isInteger(qty) || qty<1 || qty>99) delete draft[type][id];
 setFilter('#eventFilter','event','전체 행사'); setFilter('#kindFilter','kind','전체 종류'); setFilter('#memberFilter','member','전체 멤버');
 saveDraft(); render(); if(current.admin && $('#participantsDialog').open)void loadParticipants(); notifyMatches(); void loadPhotos(); subscribe(); void chat?.refresh();
}
function subscribe() {
 if (!client || !userId) return;
 const key = `${userId}:${current.account?.id || ''}:${current.me?.day || ''}`;
 if (subscriptionKey === key) return;
 if (channel) void client.removeChannel(channel);
 subscriptionKey = key;
 channel = client.channel(`poca2-${crypto.randomUUID()}`).on('postgres_changes',{event:'*',schema:'public',table:'poca2_updates'},() => void refresh()).subscribe(status => {
  if (status === 'SUBSCRIBED') { $('#connection').textContent='● 실시간 연결'; void refresh(); }
  else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') $('#connection').textContent='연결 재시도 중';
 });
}
async function refresh() {
 if (!client || !userId || busy || $('#editor').open) return;
 const seq = ++refreshSequence;
 const {data,error} = await client.rpc('poca3_state');
 if (seq !== refreshSequence || $('#editor').open) return;
 if (error) { $('#connection').textContent='연결 재시도 중'; return; }
 ready = true; apply(data); $('#connection').textContent='● 연결됨';
}
async function action(name,input = {}) {
 const keepSelection = name === 'join' && !current.me?.day ? structuredClone(draft) : null;
 ++refreshSequence;
 const {data,error} = await client.rpc('poca3_action',{action:name,input});
 if (error) { const latest=await client.rpc('poca3_state'); if(!latest.error)apply(latest.data); throw error; }
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
$$('nav button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$$('[data-mode]').forEach(b=>b.onclick=()=>choose(b.dataset.mode));
$('#goRegister').onclick=()=>showTab('register');
$('#search').oninput=renderCatalog;
for (const id of ['eventFilter','kindFilter','memberFilter']) $(`#${id}`).onchange=renderCatalog;
$('#joinForm').onsubmit=e=>{ e.preventDefault(); void run(async()=>{ await action('join',{nickname:$('#nick').value.trim(),day:$('#day').value,region:$('#region').value.trim()}); try{localStorage.setItem('pocaNick',$('#nick').value.trim());}catch{} toast('선택한 날짜·지역으로 참여했어요. 포카 목록을 올려주세요.'); }); };
async function resetSelections(type){
 if(busy)return;
 const message=type==='give'?'내놓은 포카와 연결된 교환 후보를 모두 초기화하고 게시 목록을 내립니다. 진행 중인 약속은 취소되며 도감과 완료 내역은 남아요.':'원하는 포카, 멤버 조건, 아무거나 가능을 모두 초기화합니다. 보유수량은 유지하고 진행 중인 약속은 취소해요.';
 if(!await confirm(type==='give'?'내놓은 포카를 초기화할까요?':'원하는 포카를 초기화할까요?',message))return;
 await run(async()=>{
  const nextDraft=structuredClone(draft);
  if(current.account && current.me){
   ++refreshSequence;
   const {data,error}=await client.rpc('poca_reset_selections',{selection:type,expected_revision:current.me.revision});
   if(error)throw error;++refreshSequence;apply(data);
  }
  draft=type==='give'?{give:{},want:{},conditions:{}}:{give:nextDraft.give,want:{},conditions:Object.fromEntries(Object.keys(nextDraft.give).map(id=>[id,{ids:[],members:[],any:false}]))};
  if(type==='give')activeOffer='';syncWanted();saveDraft();render();toast(type==='give'?'내놓은 포카와 교환 후보를 초기화했어요.':'원하는 포카와 교환 조건을 초기화했어요.');
 });
}
$('#resetGive').onclick=()=>void resetSelections('give');$('#resetWant').onclick=()=>void resetSelections('want');
$('#publishBtn').onclick=()=>void run(async()=>{ const selection=type=>Object.entries(draft[type]).map(([id,qty])=>({id,qty})); await action('publish',{give:selection('give'),conditions:draft.conditions,revision:current.me.revision}); showTab('matches'); toast('교환 목록에 반영했어요.'); });
$('#leaveBtn').onclick=async()=>{if(await confirm('현장에서 나갈까요?','올린 포카와 완료 대기 요청을 철회해요. 공용 도감과 거래 내역은 남아요.')) void run(async()=>{await action('leave');toast('현장에서 나왔어요. 도감은 그대로 남아 있어요.');});};
document.addEventListener('click',e=>{
 const b=e.target.closest('button'); if(!b)return;
 if(b.dataset.editCard && !busy)openEditor(cardById(b.dataset.editCard),true);
 if(b.dataset.deleteCard && !busy)void(async()=>{const id=b.dataset.deleteCard;if(await confirm('도감에서 삭제할까요?','다른 사람의 교환 목록과 진행 중인 약속에서도 제외됩니다. 완료 내역은 유지됩니다.'))void run(async()=>{await manageCatalog('delete',{id});lastDeletedId=id;renderCatalog();toast('삭제했어요. 방금 삭제 취소로 복원할 수 있어요.');});})();
 if(b.dataset.region){$('#region').value=b.dataset.region;render();}
 if(b.dataset.choose)choose(b.dataset.choose);
 if(b.dataset.action==='here') { if(!current.me?.day)return toast('교환 날짜에 먼저 참여해주세요.'); hereIndex=0;renderHere();$('#hereDialog').showModal(); }
 if(b.dataset.pick && !busy) {const id=b.dataset.pick;if(mode==='want'){if(!activeOffer)return toast('보유 포카를 먼저 선택해주세요.');const r=ruleFor(activeOffer);r.ids=r.ids.includes(id)?r.ids.filter(v=>v!==id):[...r.ids,id];syncWanted();}else{if(draft.give[id]){delete draft.give[id];delete draft.conditions[id];}else{if(Object.keys(draft.give).length>=30)return toast('최대 30종까지 선택할 수 있어요.');draft.give[id]=1;ruleFor(id);}}saveDraft();renderCatalog();renderSelections();}
 if(b.dataset.offerSelect){activeOffer=b.dataset.offerSelect;syncWanted();choose('want');}
 if(b.dataset.removeCandidate && !busy){const r=ruleFor(b.dataset.offer);r.ids=r.ids.filter(id=>id!==b.dataset.removeCandidate);syncWanted();saveDraft();renderCatalog();renderSelections();}
 if(b.dataset.any && !busy){const r=ruleFor(b.dataset.any);r.any=!r.any;saveDraft();renderSelections();}
 if(b.dataset.wantMember && !busy){const r=ruleFor(b.dataset.offer),m=b.dataset.wantMember;r.members=r.members.includes(m)?r.members.filter(v=>v!==m):[...r.members,m];saveDraft();renderSelections();}
 if(b.dataset.filterMember!==undefined){filterMember=b.dataset.filterMember;renderCatalog();}
 if(b.dataset.editorMember!==undefined){const m=b.dataset.editorMember;editorMembers=m==='단체'?(editorMembers.length===5?[]:[...MEMBERS]):editorMembers.includes(m)?editorMembers.filter(v=>v!==m):[...editorMembers,m];renderMemberEditor();}
 if(b.dataset.hereCard){if(!current.me?.day)return toast('교환 날짜에 먼저 참여해주세요.');hereIndex=Math.max(0,current.me.give.findIndex(c=>c.id===b.dataset.hereCard));renderHere();$('#hereDialog').showModal();}
 if(b.dataset.tradeAction)void run(async()=>{await action(b.dataset.tradeAction,{id:b.dataset.tradeId});toast('약속 상태를 반영했어요.');});
 if(b.dataset.step)changeQty(b.dataset.kind,b.dataset.id,(draft[b.dataset.kind][b.dataset.id]||1)+Number(b.dataset.step));
 if(b.dataset.remove && !busy){delete draft[b.dataset.kind][b.dataset.remove];delete draft.conditions[b.dataset.remove];saveDraft();renderCatalog();renderSelections();}
 if(b.dataset.request!==undefined && !busy){const m=current.matches[Number(b.dataset.request)];void run(async()=>{await action('request',{peerId:m.peerId,giveId:m.give.id,receiveId:m.receive.id});toast('15분간 1장씩 예약하고 상대방에게 약속을 요청했어요.');});}
 if(b.dataset.confirmTrade)void(async()=>{if(await confirm('교환을 완료했나요?','양쪽의 보유수량이 1장씩 줄어들고 거래 내역에 남아요.'))void run(async()=>{await action('confirm',{id:b.dataset.confirmTrade});toast('교환 완료! 남은 수량과 거래 내역을 반영했어요.');});})();
 if(b.dataset.cancelTrade)void run(async()=>{await action('cancel',{id:b.dataset.cancelTrade});toast('완료 요청을 취소했어요.');});
});
document.addEventListener('change',e=>{if(e.target.dataset.qty)changeQty(e.target.dataset.kind,e.target.dataset.qty,e.target.value);});
$('#prevCard').onclick=()=>{hereIndex--;renderHere();};$('#nextCard').onclick=()=>{hereIndex++;renderHere();};$('#closeHere').onclick=()=>$('#hereDialog').close();
$('#hereDialog').addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){hereIndex--;renderHere();}if(e.key==='ArrowRight'){hereIndex++;renderHere();}});
let touchStart;
$('#herePhoto').addEventListener('touchstart',e=>{touchStart=e.changedTouches[0].clientX;},{passive:true});
$('#herePhoto').addEventListener('touchend',e=>{const delta=e.changedTouches[0].clientX-touchStart;if(Math.abs(delta)>45){hereIndex+=delta<0?1:-1;renderHere();}},{passive:true});
function openEditor(old,editing=false) {
 ++refreshSequence;
 editingId=editing?old.id:null;
 if(!current.account)return; editorMembers=[];
 photoData=old?.img || '';uploadedPhoto='';generatedName='';$('#cardForm').reset();$('#editorError').textContent='';
 editorMembers=editing?[...(old.members || [])]:[];renderMemberEditor();$('#catalogEvent').value=editing?old.event:'';$('#catalogKind').value=editing?old.kind:'';$('#editorTitle').textContent=editing?'도감 사진 · 정보 수정':'공용 도감에 추가';$('#saveCard').textContent=editing?'수정 저장':'공용 도감에 저장';$('#cardName').value='';$('#catalogRelease').value=editing?old.release || '':'';
 const events=[...new Set(current.catalog.map(c=>c.event))].sort((a,b)=>a.localeCompare(b,'ko'));
 $('#existingEvent').innerHTML='<option value="">직접 입력</option>'+events.map(event=>`<option value="${esc(event)}">${esc(event)}</option>`).join('');$('#existingEvent').value=editing?old.event:'';
 const releases=[...new Set(current.catalog.map(c=>c.release).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
 $('#existingRelease').innerHTML='<option value="">직접 입력</option>'+releases.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');$('#existingRelease').value=editing?old.release || '':'';
 const kinds=[...new Set(current.catalog.map(c=>c.kind))].sort((a,b)=>a.localeCompare(b,'ko'));
 $('#existingKind').innerHTML='<option value="">직접 입력</option>'+kinds.map(kind=>`<option value="${esc(kind)}">${esc(kind)}</option>`).join('');$('#existingKind').value=editing?old.kind:'';
 $('#preview').hidden=!old;$('#preview').src=old?imageURL(old):'';$('#editor').showModal();
}
$('#existingRelease').onchange=()=>{if($('#existingRelease').value)$('#catalogRelease').value=$('#existingRelease').value;else $('#catalogRelease').focus();};
$('#catalogRelease').oninput=()=>{$('#existingRelease').value=$('#catalogRelease').value;};
$('#existingKind').onchange=()=>{if($('#existingKind').value){$('#catalogKind').value=$('#existingKind').value;$('#catalogKind').dispatchEvent(new Event('input'));}else $('#catalogKind').focus();};
$('#catalogKind').addEventListener('input',()=>{$('#existingKind').value=[...$('#existingKind').options].some(o=>o.value===$('#catalogKind').value)?$('#catalogKind').value:'';});
$('#existingEvent').onchange=()=>{if($('#existingEvent').value)$('#catalogEvent').value=$('#existingEvent').value;else $('#catalogEvent').focus();};
$('#catalogEvent').oninput=()=>{$('#existingEvent').value=[...$('#existingEvent').options].some(o=>o.value===$('#catalogEvent').value)?$('#catalogEvent').value:'';};
$('#addBtn').onclick=()=>{if(ready&&!busy)openEditor();};$('#closeEditor').onclick=()=>{if(!photoLoading&&!busy)$('#editor').close();};
$('#editor').addEventListener('close',()=>{render();void refresh();});
$('#editor').addEventListener('cancel',e=>{if(photoLoading||busy)e.preventDefault();});
for(const id of ['catalogKind','catalogMember']) $(`#${id}`).addEventListener('input',()=>{
 if(!editingId && (!$('#cardName').value.trim() || $('#cardName').value === generatedName)) {
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
 const info={event:$('#catalogEvent').value.trim(),release:$('#catalogRelease').value.trim(),kind:$('#catalogKind').value.trim(),member:$('#catalogMember').value.trim(),members:editorMembers,name:$('#cardName').value.trim()};
 if(!photoData || !info.name || !info.event || !info.kind || !info.members.length){ $('#editorError').textContent='사진과 도감 정보를 모두 입력해주세요.';return;}
 void run(async()=>{
  $('#saveCard').disabled=true;$('#editorError').textContent='';
  try{
   if(!uploadedPhoto){
    if((editingId && photoData===cardById(editingId)?.img) || photoData.startsWith(`${userId}/`))uploadedPhoto=photoData;
    else{
     const source=/^(data:image\/jpeg;base64,|images\/poca_0[1-5]\.jpg$)/.test(photoData)?photoData:photoURLs.get(photoData)?.url;
     if(!source)throw new Error('기존 사진을 다시 선택해주세요.');
     const response=await fetch(source);if(!response.ok)throw new Error('사진을 가져오지 못했어요.');const blob=await response.blob();
     const path=`${userId}/${crypto.randomUUID()}.jpg`;const {error}=await client.storage.from('poca-photos').upload(path,blob,{contentType:'image/jpeg',upsert:false});if(error)throw error;uploadedPhoto=path;
    }
   }
   if(editingId)await manageCatalog('edit',{...info,id:editingId,img:uploadedPhoto});else await action('catalog_add',{...info,img:uploadedPhoto});
   // Catalog registration does not add a personal offer.
   saveDraft();$('#editor').close();$('#search').value='';$('#eventFilter').value='';$('#kindFilter').value='';$('#memberFilter').value='';filterMember='';render();toast('공용 도감에 저장했어요. 사진과 이름은 계속 남아요.');
  }catch(error){$('#editorError').textContent=error.message;}
  finally{$('#saveCard').disabled=false;}
 });
};
function renderMemberEditor(){
 $('#editorMembers').innerHTML=[...MEMBERS,'단체'].map(m=>`<button type="button" data-editor-member="${m}" aria-pressed="${m==='단체'?editorMembers.length===5:editorMembers.includes(m)}">${m}</button>`).join('');
 $('#catalogMember').value=editorMembers.length===5?'단체':MEMBERS.filter(m=>editorMembers.includes(m)).join(' + ');
 $('#catalogMember').dispatchEvent(new Event('input'));
}
async function manageCatalog(operation,input){
 ++refreshSequence;const {data,error}=await client.rpc('poca_catalog_manage',{operation,input});if(error)throw error;++refreshSequence;apply(data);
}
$('#catalogColumns').onchange=()=>{catalogColumns=Number($('#catalogColumns').value);try{localStorage.setItem('pocaCatalogColumns',JSON.stringify(catalogColumns));}catch{}renderCatalog();};
$('#undoCatalogDelete').onclick=()=>void run(async()=>{await manageCatalog('restore',{id:lastDeletedId});lastDeletedId=null;renderCatalog();toast('도감에 복원했어요. 교환 목록은 다시 선택해주세요.');});
$('#offerPicker').onchange=()=>{activeOffer=$('#offerPicker').value;syncWanted();renderCatalog();};
async function login(register){
 if(!$('#loginForm').reportValidity() || busy || !ready)return;
 const nickname=$('#loginNick').value.trim(),pin=$('#loginPin').value;
 const beforeLogin=!current.account?structuredClone(draft):null;
 busy=true;++refreshSequence;render();$('#loginError').textContent='';
 try{let {data,error}=await client.rpc('poca3_login',{nickname,pin,register});
 if(register && !error && data?.code==='DEVICE_ACCOUNT_EXISTS'){
  const signed=await client.auth.signInAnonymously();if(signed.error)throw signed.error;
  userId=signed.data.user.id;
  ({data,error}=await client.rpc('poca3_login',{nickname,pin,register}));
 }
 if(error || data?.error)throw Error(error?.message || data.error);++refreshSequence;initialized=false;apply(data);if(beforeLogin && !data.me?.give?.length && Object.keys(beforeLogin.give).length){draft=beforeLogin;saveDraft();render();}$('#loginPin').value='';toast('등록정보와 거래내역을 불러왔어요.');}
 catch(e){$('#loginError').textContent=e.message;}
 finally{busy=false;render();}
}
$('#loginForm').onsubmit=e=>{e.preventDefault();void login(false);};$('#signupBtn').onclick=()=>void login(true);
$('#logoutBtn').onclick=()=>void run(async()=>{await action('logout');draft={give:{},want:{},conditions:{}};saveDraft();$('#loginPin').value='';toast('로그아웃했어요. 등록정보와 내역은 남아요.');});
chat=setupChat({getClient:()=>client,getAccount:()=>current.account,esc,toast,showHere:id=>{
 const index=current.me?.give?.findIndex(c=>c.id===id) ?? -1;if(index<0)return toast('현재 올린 포카가 없어요.');hereIndex=index;renderHere();$('#hereDialog').showModal();
}});
const now=new Date();$('#day').value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
try{$('#nick').value=localStorage.getItem('pocaNick')||'';}catch{}
render();
if(configured){
 try{
  client=createClient(url,publicKey);const {data:{session},error}=await client.auth.getSession();if(error)throw error;
  let active=session;if(!active){const signed=await client.auth.signInAnonymously();if(signed.error)throw signed.error;active=signed.data.session;}
  userId=active.user.id;await refresh();if(!ready)throw new Error('데이터베이스 연결을 확인해주세요.');
  setInterval(()=>{if(!document.hidden)void refresh();},15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
 }catch(error){$('#connection').textContent='연결 실패';toast(error.message);}
}else{$('#connection').textContent='연결 준비 중';$('#catalogCount').textContent='Supabase 연결 설정이 필요해요.';}


function matchKey(m){return [current.me?.day,current.me?.region,m.peerId,m.give.id,m.receive.id].join('|');}
function notifyMatches(){
 const owner=current.account?.id || '';
 if(owner!==notifiedOwner){notifiedOwner=owner;seenMatches=new Set(owner?readLocal('pocaMatchSeen:'+owner,[]):[]);$('#matchAlert').hidden=true;}
 if(!owner)return;
 const fresh=current.matches.filter(m=>m.mutual && !seenMatches.has(matchKey(m)));
 if(!fresh.length)return;
 fresh.forEach(m=>seenMatches.add(matchKey(m)));try{localStorage.setItem('pocaMatchSeen:'+owner,JSON.stringify([...seenMatches]));}catch{}
 alertKey=matchKey(fresh[0]);$('#matchAlert').textContent='💕 새로운 맞교환 '+fresh.length+'건! 눌러서 확인하기';$('#matchAlert').hidden=false;
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches)try{navigator.vibrate?.(120);}catch{}
}
$('#matchAlert').onclick=()=>{showTab('matches');$('#matchAlert').hidden=true;const target=$$('[data-match-key]').find(el=>el.dataset.matchKey===alertKey);target?.scrollIntoView({block:'center'});};
function updateCountdowns(){
 let expired=false;
 $$('[data-expires]').forEach(el=>{const seconds=Math.max(0,Math.ceil((Date.parse(el.dataset.expires)-Date.now())/1000));if(!Number.isFinite(seconds)){el.textContent='';return;}el.textContent=seconds?'남은 시간 '+Math.floor(seconds/60)+'분 '+String(seconds%60).padStart(2,'0')+'초':'시간 만료 · 교환 가능으로 전환 중';if(!seconds){expired=true;el.closest('article').querySelectorAll('[data-trade-action]').forEach(b=>b.disabled=true);}});
 if(expired && Date.now()-expiryRefresh>5000){expiryRefresh=Date.now();void refresh();}
}
setInterval(updateCountdowns,1000);

function renderParticipants(){const q=normalize($('#participantSearch').value);const rows=participants.filter(p=>normalize([p.nickname].join(' ')).includes(q));$('#participantCount').textContent=rows.length+'명';$('#participantList').innerHTML=rows.map(p=>`<article class="participant"><strong>${esc(p.nickname)}</strong><span>${p.devices}개 기기</span><small>로그인 만료 ${esc(new Date(p.expiresAt).toLocaleTimeString('ko-KR'))}</small>${p.id===current.account?.id?'<span>내 계정</span>':`<button class="danger" data-force-logout="${p.id}">강제 로그아웃</button>`}</article>`).join('') || '<p class="muted">로그인된 계정이 없습니다.</p>';}
async function loadParticipants(){if(!current.admin)return;const owner=current.account.id,request=++participantRequest;$('#refreshParticipants').disabled=true;$('#participantCount').textContent='불러오는 중';try{const {data,error}=await client.rpc('poca_admin_participants');if(request!==participantRequest || current.account?.id!==owner || !current.admin)return;if(error)throw error;participants=data;renderParticipants();}catch(e){if(request===participantRequest){participants=[];$('#participantList').replaceChildren();$('#participantCount').textContent=e.message;}}finally{if(request===participantRequest)$('#refreshParticipants').disabled=false;}}
$('#adminParticipants').onclick=()=>{$('#participantsDialog').showModal();void loadParticipants();};$('#closeParticipants').onclick=()=>$('#participantsDialog').close();$('#refreshParticipants').onclick=()=>void loadParticipants();$('#participantSearch').oninput=renderParticipants;

function expireSession(){if(!current.account || !current.sessionExpiresAt || Date.parse(current.sessionExpiresAt)>Date.now())return;++refreshSequence;initialized=false;apply({...current,account:null,admin:false,me:null,matches:[],listings:[],trades:[],count:0});}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)expireSession();});
// Verify expiry and revocation even while the editor is open.
let checkingSession=false;
async function checkSession(){
 expireSession();if(!current.account || !client || busy || checkingSession || document.hidden || !$('#editor').open)return;
 checkingSession=true;const owner=current.account.id,sequence=refreshSequence;
 try{const {data,error}=await client.rpc('poca3_state');if(error || current.account?.id!==owner || sequence!==refreshSequence)return;if(!data.account){++refreshSequence;apply(data);}else if($('#participantsDialog').open)void loadParticipants();}finally{checkingSession=false;}
}
setInterval(()=>void checkSession(),15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkSession();});
document.addEventListener('click',e=>{const b=e.target.closest('[data-force-logout]');if(!b || !current.admin || busy)return;const person=participants.find(p=>p.id===b.dataset.forceLogout);if(!person)return;void(async()=>{if(!await confirm(person.nickname+'님을 로그아웃시킬까요?','이 계정으로 로그인한 모든 기기에서 로그아웃됩니다. 포카와 거래내역은 유지됩니다.'))return;await run(async()=>{const {data,error}=await client.rpc('poca_admin_logout',{target:person.id});if(error)throw error;participants=data;renderParticipants();toast('강제 로그아웃했습니다.');});})();});

const recordCard=c=>`<p><strong>${esc(c?.name || '포카')}</strong> · ${esc(c?.qty ?? 1)}장<small class="muted"> ${c?metadata(c):''}</small></p>`;
async function loadRecords(more=false){
 if(!current.admin)return;const owner=current.account.id,token=++recordRequest,page=more?recordPage+1:0;if(!more){recordQuery=$('#recordsSearch').value.trim();$('#recordsList').replaceChildren();}$('#recordsMore').disabled=true;$('#recordsStatus').textContent='불러오는 중';
 try{const {data,error}=await client.rpc('poca_admin_records',{section:recordSection,query:recordQuery,page});if(token!==recordRequest || !current.admin || current.account?.id!==owner)return;if(error)throw error;
 const html=data.rows.map(r=>recordSection==='listings'?`<article class="match"><h3>${esc(r.nickname)}님 · #${esc(r.exchangeNo)}</h3><small>${esc(r.day)} · ${esc(r.region)}</small>${r.give.map(recordCard).join('')}</article>`:`<article class="match"><h3>${esc(r.fromNick)} ↔ ${esc(r.toNick)}</h3><small>${esc(r.room)} · ${esc(r.region || '')}</small><p>${esc(r.fromNick)}님이 준 포카</p>${recordCard(r.give)}<p>${esc(r.toNick)}님이 준 포카</p>${recordCard(r.receive)}<small>완료 ${esc(r.completedAt?new Date(r.completedAt).toLocaleString('ko-KR'):'기록 없음')}</small></article>`).join('');
 $('#recordsList').insertAdjacentHTML('beforeend',html);recordPage=page;$('#recordsMore').hidden=!data.hasMore;$('#recordsStatus').textContent=$('#recordsList').children.length+'건'+(data.hasMore?' · 더 보기 가능':'');
 }catch(e){if(token===recordRequest)$('#recordsStatus').textContent=e.message;}finally{if(token===recordRequest)$('#recordsMore').disabled=false;}
}
$('#adminRecords').onclick=()=>{$('#recordsDialog').showModal();void loadRecords();};$('#closeRecords').onclick=()=>$('#recordsDialog').close();$('#recordsSearchForm').onsubmit=e=>{e.preventDefault();void loadRecords();};$('#recordsMore').onclick=()=>void loadRecords(true);
$$('[data-record-section]').forEach(b=>b.onclick=()=>{recordSection=b.dataset.recordSection;$$('[data-record-section]').forEach(el=>el.classList.toggle('on',el===b));void loadRecords();});
