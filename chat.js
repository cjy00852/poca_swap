export function setupChat({getClient,getAccount,esc,toast,showHere}){
 const $=s=>document.querySelector(s);let owner=null,rooms=[],active=null,messages=[],loading=false,sending=false,generation=0,pending=null;const photos=new Map();
 async function rpc(action,input={}){const {data,error}=await getClient().rpc('poca_chat',{action,input});if(error)throw error;return data;}
 function renderRooms(){
 const unread=rooms.reduce((n,r)=>n+Number(r.unread),0);$('#chatBadge').textContent=unread?` ${unread}`:'';
 $('#chatRooms').innerHTML=rooms.map(r=>`<button class="chat-room" data-chat-room="${r.id}"><strong>${esc(r.nickname)} · #${esc(r.number)}</strong>${r.unread?`<span class="pill">새 메시지 ${r.unread}</span>`:''}<small>${esc(r.last || '만날 장소를 이야기해보세요.')}</small></button>`).join('') || '<p class="muted">교환 후보의 1:1 채팅 버튼으로 대화를 시작하세요.</p>';
 }
 function renderMessages(){
 const box=$('#chatMessages'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;
 box.innerHTML=messages.map(m=>`<div class="chat-message ${m.sender===owner?'mine':''}"><p>${esc(m.body)}</p><time>${esc(new Date(m.created_at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}))}</time></div>`).join('') || '<p class="muted">만날 위치와 시간을 이야기해보세요.</p>';
 if(nearBottom)box.scrollTop=box.scrollHeight;
 }
 async function context(room){
 const cards=[room.context[room.amA?'aCard':'bCard'],room.context[room.amA?'bCard':'aCard']];
 const token=generation;
 for(const c of cards){if(!c || photos.has(c.img))continue;if(c.img.startsWith('images/'))photos.set(c.img,c.img);else{const {data}=await getClient().storage.from('poca-photos').createSignedUrl(c.img,3600);if(data?.signedUrl)photos.set(c.img,data.signedUrl);}}
 if(token!==generation || active!==room.id)return;
 $('#chatContext').innerHTML=cards.map((c,i)=>c?`<div>${photos.has(c.img)?`<img src="${esc(photos.get(c.img))}" alt="${esc(c.name)}">`:''}<small>${i?'상대 포카':'내 포카'}</small><b>${esc(c.name)}</b></div>`:'').join('');
 }
 async function fetchMessages(older=false){
 const id=active,token=generation;if(!id)return;
 const data=await rpc('messages',{id,...(older&&messages.length?{before:messages[0].seq}:{})});if(token!==generation||id!==active)return;
 const oldHeight=$('#chatMessages').scrollHeight,oldTop=$('#chatMessages').scrollTop;
 messages=[...new Map([...messages,...data.messages].map(m=>[m.seq,m])).values()].sort((a,b)=>a.seq-b.seq);
 renderMessages();if(older)$('#chatMessages').scrollTop=oldTop+$('#chatMessages').scrollHeight-oldHeight;
 if(older || messages.length===data.messages.length)$('#chatOlder').hidden=!data.hasOlder;
 if(!document.hidden && $('#chatDialog').open && messages.length){await rpc('read',{id,through:messages.at(-1).seq});const r=rooms.find(r=>r.id===id);if(r)r.unread=0;renderRooms();}
 }
 async function openRoom(id){
 active=id;messages=[];pending=null;++generation;const r=rooms.find(r=>r.id===id);if(!r)return;
 $('#chatInbox').hidden=true;$('#chatConversation').hidden=false;$('#chatTitle').textContent=`${r.nickname} · #${r.number}`;$('#chatText').value='';$('#chatError').textContent='';$('#chatContext').innerHTML='';$('#chatOlder').hidden=true;renderMessages();void context(r);await fetchMessages();$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;
 }
 async function refresh(){
 const account=getAccount();$('#openChats').hidden=!account;
 if(owner!==account?.id){owner=account?.id;rooms=[];active=null;messages=[];pending=null;++generation;if($('#chatDialog').open)$('#chatDialog').close();renderRooms();}
 if(!owner||loading)return;loading=true;const token=generation;
 try{const data=await rpc('list');if(token!==generation)return;rooms=data.rooms;renderRooms();if(active&&$('#chatDialog').open)await fetchMessages();}
 catch(e){if($('#chatDialog').open)$('#chatError').textContent=e.message;}
 finally{loading=false;}
 }
 $('#openChats').onclick=()=>{active=null;++generation;$('#chatTitle').textContent='1:1 채팅';$('#chatInbox').hidden=false;$('#chatConversation').hidden=true;$('#chatDialog').showModal();void refresh();};
 $('#closeChat').onclick=()=>$('#chatDialog').close();$('#chatDialog').addEventListener('close',()=>{active=null;++generation;});
 $('#chatBack').onclick=()=>{active=null;++generation;$('#chatInbox').hidden=false;$('#chatConversation').hidden=true;$('#chatTitle').textContent='1:1 채팅';void refresh();};
 $('#chatOlder').onclick=()=>void fetchMessages(true).catch(e=>toast(e.message));
 $('#chatHere').onclick=()=>{const r=rooms.find(r=>r.id===active);if(r)showHere(r.context[r.amA?'aCard':'bCard'].id);};
 document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
 if(b.dataset.chatRoom)void openRoom(b.dataset.chatRoom).catch(e=>toast(e.message));
 if(b.dataset.chatPeer)void(async()=>{try{if(!getAccount())return toast('로그인 후 채팅해주세요.');const accountId=getAccount().id;const {id}=await rpc('open',{peerId:b.dataset.chatPeer,giveId:b.dataset.chatGive,receiveId:b.dataset.chatReceive});const data=await rpc('list');if(getAccount()?.id!==accountId)return;rooms=data.rooms;renderRooms();if(!$('#chatDialog').open)$('#chatDialog').showModal();await openRoom(id);}catch(e){toast(e.message);}})();
 });
 $('#chatForm').onsubmit=e=>{e.preventDefault();if(sending||!active)return;const body=$('#chatText').value.trim();if(!body)return;const id=active,token=generation;if(!pending||pending.body!==body||pending.id!==id)pending={id,body,messageId:crypto.randomUUID()};sending=true;$('#chatSend').disabled=true;$('#chatError').textContent='';
 void(async()=>{try{await rpc('send',pending);if(token!==generation)return;pending=null;if($('#chatText').value.trim()===body)$('#chatText').value='';await fetchMessages();$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;}catch(err){if(token===generation)$('#chatError').textContent=err.message;}finally{sending=false;$('#chatSend').disabled=false;}})();
 };
 return {refresh};
}
