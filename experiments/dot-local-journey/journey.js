/* global document, clearInterval, setInterval */
'use strict';
// Inert scenario model. No fetch, credentials, storage, network or product actions.
const stages=['준비 확인','연결 동의','공유 범위','요청 진행','결과 확인','연결 관리'];
const lessons=['컴퓨터 접근·플러그인 설치·AgentDeck 권한을 따로 설명해요.','권한과 데이터 목적지를 승인 전에 보여줘요. 거절하면 연결이 생기지 않아요.','전체 대화 대신 선택한 자료를 미리 보고 공유해요.','연결 상태와 요청 보고를 분리해요. 보고가 없으면 완료를 추측하지 않아요.','완료는 이 요청의 보고예요. 전체 Dot 활동이나 자동 실행의 증거는 아니에요.','철회 이후의 접근, 기존 데이터, 컴퓨터 권한을 구분해요.'];
let step=0,scenario='happy',phase='ready',timer=null;
const panel=document.getElementById('panel');
const action=(text,id,quiet=false)=>`<button data-action="${id}"${quiet?' class="quiet"':''}>${text}</button>`;
const state=(text,tone='')=>`<div class="state ${tone}"><i class="signal" aria-hidden="true"></i>${text}</div>`;
const detail=(a,b)=>`<div class="detail"><strong>${a}</strong><span>${b}</span></div>`;
const actions=(...items)=>`<div class="actions">${items.join('')}</div>`;
function stop(){clearInterval(timer);timer=null;document.getElementById('play').textContent='1분 소개 재생';}
function render(focusPanel=false){
 document.getElementById('step-list').innerHTML=stages.map((x,i)=>`<li><button data-step="${i}"${i===step?' aria-current="step"':''}>${i+1}. ${x}</button></li>`).join('');
 document.getElementById('position').textContent=`${step+1} / 6`;
 document.getElementById('lesson').textContent=lessons[step];
 document.getElementById('back').disabled=step===0;
 let h='';
 if(step===0)h=state('아직 연결하지 않았어요')+'<h2>먼저 이 Mac을 준비해요</h2><p class="sub">Dot의 로컬 작업에는 온라인인 Mac과 실행 중인 ChatGPT 앱이 필요해요.</p>'+detail('Dot의 컴퓨터 접근','ChatGPT에서 별도 허용')+detail('AgentDeck 로컬 플러그인','설치·자동 도구 노출 검증 전')+detail('AgentDeck 권한','다음 단계에서 별도 동의')+actions(action('준비된 상황 보기','next'));
 if(step===1){
  h=state('승인 대기','attention')+'<h2>공유한 요청을 연결할까요?</h2><p class="sub">이 연결은 AgentDeck에 명시적으로 공유한 요청을 읽고, 그 요청의 진행과 결과를 보고할 수 있어요.</p>'+detail('허용 범위','선택한 문맥 읽기 · 해당 요청 보고')+detail('데이터 처리','공유 문맥과 결과는 OpenAI에서 처리')+detail('비교 코드 · 예시','<strong class="code">DEMO 26</strong>')+'<p class="notice">일반 사용자용 설치·동의 화면 제안이에요. 실제 권한을 만들지 않아요.</p>'+actions(action('동의 재현','approve'),action('거절 재현','deny',true));
  if(phase==='denied')h=state('연결되지 않았어요')+'<h2>승인을 거절했어요</h2><p class="sub">AgentDeck 연결 권한이 생성되지 않았어요. 계속하려면 연결을 다시 요청하고 범위를 확인해요.</p>'+actions(action('동의 화면 다시 보기','consent'),action('준비 화면으로','reset',true));
 }
 if(step===2)h=state('연결됨 · 요청은 아직 공유하지 않음','connected')+'<h2>공유할 내용을 먼저 확인해요</h2><p class="sub">예시 요청: 릴리즈 체크리스트에서 남은 검증을 요약해 줘.</p><div class="context"><strong>공유할 문맥 · 합성 예시</strong><p>로컬 요청 왕복: 확인됨<br>일반 사용자 설치: 미검증<br>실제 장비의 결과 표시: 미검증</p></div><p class="sub">이 예시에는 체크리스트만 포함돼요. 파일 전체나 기존 대화를 자동으로 추가하지 않아요.</p>'+actions(action('이 자료 공유 재현','next'),action('공유 취소 재현','cancel-share',true));
 if(step===2&&phase==='cancelled')h=state('연결됨 · 요청은 공유하지 않음','connected')+'<h2>이번 공유를 취소했어요</h2><p class="sub">선택한 문맥을 보내지 않았어요. AgentDeck 연결은 유지되며, 필요할 때 자료를 다시 확인하고 공유할 수 있어요.</p>'+actions(action('공유 범위 다시 보기','review'),action('연결 관리','manage',true));
 if(step===3){
  if(phase==='ready')h=state('공유됨 · 아직 보고 없음','connected')+'<h2>Dot에 이 요청을 맡겨요</h2><p class="sub">Dot에 “AgentDeck에 공유한 릴리즈 체크리스트를 요약해 줘”라고 요청하는 상황이에요.</p><div class="notice">공유만으로 Dot이 자동 실행되지는 않아요. 플러그인 자동 도구 인식과 버튼에서 시작하는 기능은 별도 검증이 필요해요.</div>'+actions(action('Dot 요청 재현','work'));
  else if(['offline','stale','expired'].includes(scenario)){
   const title={offline:'Mac 연결을 확인해 주세요',stale:'현재 작업 상태를 알 수 없어요',expired:'AgentDeck 연결 동의가 필요해요'}[scenario];
   const body={offline:'Mac이 온라인인지, ChatGPT와 AgentDeck이 실행 중인지 확인해요. 마지막 보고가 작업 중이었어도 현재 상태로 단정하지 않아요.',stale:'연결은 유지되지만 새 보고를 받지 못했어요. 완료나 실패로 바꾸지 않고 마지막 보고를 과거 기록으로 남겨요.',expired:'연결 권한이 만료됐거나 철회됐을 수 있어요. 새 동의가 끝나기 전에 요청을 다시 보내지 않아요.'}[scenario];
   h=state(scenario==='expired'?'재연결 필요':'현재 상태 미확인',scenario==='expired'?'attention':'')+`<h2>${title}</h2><p class="sub">${body}</p>`+detail('마지막 수신 보고','이 요청 · 작업 중 · 3분 전 (예시)')+actions(action(scenario==='expired'?'다시 동의하기':'복구 상황 재현',scenario==='expired'?'reauthorize':'recover'),action('연결 관리','manage',true));
  }else h=state('이 요청 · 작업 중','working')+'<h2>선택한 체크리스트를 살펴보고 있어요</h2><p class="sub">Dot에서 받은 작업 보고를 이 요청에만 표시해요. 연결됐다는 이유로 모든 Dot 작업을 감지하지 않아요.</p>'+detail('요청','릴리즈 체크리스트 요약')+detail('최근 보고','체크리스트 항목 확인 중 · 방금')+actions(action('완료 보고 재현','next'));
 }
 if(step===4)h=state('이 요청 · 완료 보고 수신','connected')+'<h2>이 예시에서 남은 두 항목을 확인했어요</h2><div class="context"><strong>예시 완료 보고</strong><p>일반 사용자의 설치·동의 흐름과 실제 장비의 결과 표시를 확인해야 해요. 로컬 요청 왕복은 확인됐어요.</p></div><p class="sub">선택한 발췌 안의 예시 결과예요. 전체 출시 조건이 두 가지라는 뜻은 아니에요. 실제 Dot 검증과 출시 판단은 아래에서 별도로 확인해요.</p>'+actions(action('연결 관리 보기','next'));
 if(step===5){
  h=state('AgentDeck 연결 활성','connected')+'<h2>필요할 때 연결을 끊을 수 있어요</h2><p class="sub">철회하면 이 연결을 통한 이후 요청 접근이 차단돼요. 다시 쓰려면 새로 동의해요.</p><div class="notice">Dot의 컴퓨터 접근은 ChatGPT에서 따로 철회해요. 이미 전달한 문맥은 소급 삭제되지 않고, 진행 중인 Dot 작업도 이 버튼으로 취소되지 않아요.</div>'+actions(action('연결 철회 재현','revoke'),action('처음부터 살펴보기','reset',true));
  if(phase==='revoked')h=state('연결 철회됨')+'<h2>이후 접근을 차단했어요</h2><p class="sub">이 모형의 연결을 해제했어요. 실제 검증에서도 철회한 권한으로 읽기를 시도했을 때 거절됐어요.</p>'+detail('새 요청 접근','허용하지 않음')+detail('Dot 컴퓨터 접근','별도 권한 · ChatGPT에서 관리')+actions(action('다시 연결 흐름 보기','reset'));
 }
 panel.innerHTML=h;
 if(focusPanel){const heading=panel.querySelector('h2');heading.tabIndex=-1;heading.focus({preventScroll:true});}
}
function act(kind){
 stop();
 if(kind==='next'){step=Math.min(5,step+1);phase='ready';}
 if(kind==='approve'){step=2;phase='ready';}
 if(kind==='deny')phase='denied';
 if(kind==='consent'){scenario='happy';document.getElementById('scenario').value='happy';phase='ready';}
 if(kind==='cancel-share')phase='cancelled';
 if(kind==='review')phase='ready';
 if(kind==='work')phase='working';
 if(kind==='recover'){scenario='happy';document.getElementById('scenario').value='happy';phase='working';}
 if(kind==='reauthorize'){step=1;scenario='happy';document.getElementById('scenario').value='happy';phase='ready';}
 if(kind==='manage'){step=5;phase='ready';}
 if(kind==='revoke')phase='revoked';
 if(kind==='reset'){step=0;phase='ready';scenario='happy';document.getElementById('scenario').value='happy';}
 render(true);
}
document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.action)act(b.dataset.action);if(b.dataset.step!==undefined){stop();step=Number(b.dataset.step);phase='ready';render(true);}});
document.getElementById('scenario').addEventListener('change',event=>{stop();scenario=event.target.value;step=scenario==='denied'?1:scenario==='revoke'?5:scenario==='happy'?0:3;phase=scenario==='denied'?'denied':['offline','stale','expired'].includes(scenario)?'working':'ready';render();});
document.getElementById('reset').addEventListener('click',()=>act('reset'));
document.getElementById('back').addEventListener('click',()=>{stop();step=Math.max(0,step-1);phase='ready';render();});
document.getElementById('play').addEventListener('click',()=>{if(timer){stop();return;}document.querySelector('.walkthrough').scrollIntoView({behavior:'instant',block:'start'});scenario='happy';document.getElementById('scenario').value='happy';step=0;phase='ready';render();document.getElementById('play').textContent='소개 일시 정지';const frames=[[1,'ready'],[2,'ready'],[3,'ready'],[3,'working'],[4,'ready'],[5,'ready'],[5,'revoked']];let i=0;timer=setInterval(()=>{[step,phase]=frames[i++];render();if(i===frames.length)stop();},8500);});
render();
