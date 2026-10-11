import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../db.mjs';
import {createApp} from '../server.mjs';
import {slotState as intervalState} from '../logic.mjs';
const slotState=(data,member,date,start)=>intervalState(data,member,date,start,start+30);

test('여러 요일을 원자적으로 저장·수정하고 다른 세션에서 조회하며 재시도 중복을 방지',async()=>{
 const db=openDb(':memory:'),server=createApp(db);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,method='GET',body,cookie=''){
  const res=await fetch(base+'/api'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),cookie},body:body?JSON.stringify(body):undefined});
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  assert.equal((await fetch(base+'/calendar.js')).status,200);
  const owner=await request('/projects','POST',{name:'시간표 검증',nickname:'방장'});
  const member=await request('/join','POST',{code:owner.data.inviteCode,nickname:'조원'});
  const path=`/projects/${owner.data.projectId}/schedules`;
  const memberId=(await request('/me','GET',undefined,member.cookie)).data.id;
  const body={kind:'weekly',days:[1,3,5],start_min:570,end_min:660,status:'unavailable',title:'수업',requestId:'multi-create'};
  const result=await request(path,'POST',body,member.cookie);assert.equal(result.status,201);assert.equal(result.data.ids.length,3);
  assert.deepEqual((await request(path,'POST',body,member.cookie)).data.ids,result.data.ids);
  let data=(await request(path,'GET',undefined,owner.cookie)).data;
  assert.deepEqual(data.schedules.map(x=>x.day),[1,3,5]);assert.equal(data.schedules.length,3);
  assert.equal(data.schedules.every(x=>x.title===''),true);
  for(const date of ['2026-10-12','2026-10-14','2026-10-16'])assert.equal(slotState(data,memberId,date,570),'unavailable');
  assert.equal(slotState(data,memberId,'2026-10-13',570),'unknown');
  for(const days of [[],[1,9],[null],[true],[''],[1,2,3,4,5,6,0,1]])assert.equal((await request(path,'POST',{...body,days,requestId:undefined},member.cookie)).status,400);
  assert.equal((await request(path,'GET',undefined,member.cookie)).data.schedules.length,3);
  const edit={...body,days:[1,2],status:'available',version:1,requestId:'multi-edit'};
  assert.equal((await request(path+'/'+result.data.id,'PATCH',edit,owner.cookie)).status,403);
  const edited=await request(path+'/'+result.data.id,'PATCH',edit,member.cookie);assert.equal(edited.status,200);assert.equal(edited.data.ids.length,2);
  assert.deepEqual((await request(path+'/'+result.data.id,'PATCH',edit,member.cookie)).data.ids,edited.data.ids);
  assert.equal((await request(path+'/'+result.data.id,'PATCH',{...edit,requestId:'stale-edit'},member.cookie)).status,409);
  data=(await request(path,'GET',undefined,owner.cookie)).data;assert.equal(data.schedules.length,4);
  assert.equal(slotState(data,memberId,'2026-10-12',570),'available');assert.equal(slotState(data,memberId,'2026-10-13',570),'available');
  const sleep=await request(path,'POST',{kind:'sleep',days:[0,6],start_min:1380,end_min:1860,title:'취침'},member.cookie);assert.equal(sleep.status,201);
  data=(await request(path,'GET',undefined,owner.cookie)).data;
  assert.equal(slotState(data,memberId,'2026-10-12',0),'unavailable');
  // A move to a different weekday updates the existing row rather than leaving a copy on its old day.
  const moved=await request(path+'/'+edited.data.ids[1],'PATCH',{days:[4],version:1},member.cookie);assert.equal(moved.status,200);
  data=(await request(path,'GET',undefined,owner.cookie)).data;
  assert.equal(slotState(data,memberId,'2026-10-13',570),'unknown');assert.equal(slotState(data,memberId,'2026-10-15',570),'available');
 }finally{await new Promise(r=>server.close(r));db.close()}
});

test('일괄 삭제는 본인 일정의 최신 버전만 전부 삭제하고 오류 시 일부도 삭제하지 않는다',async()=>{
 const db=openDb(':memory:'),server=createApp(db);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,method='GET',body,cookie=''){
  const res=await fetch(base+'/api'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),cookie},body:body?JSON.stringify(body):undefined});
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  const owner=await request('/projects','POST',{name:'일괄 삭제 검증',nickname:'방장'});
  const member=await request('/join','POST',{code:owner.data.inviteCode,nickname:'조원'});
  const path=`/projects/${owner.data.projectId}/schedules`;
  const recurring={kind:'weekly',days:[1,3,5],start_min:540,end_min:600,status:'unavailable',title:'수업'};
  const created=await request(path,'POST',recurring,member.cookie);
  const foreign=await request(path,'POST',{...recurring,days:[1]},owner.cookie);
  const items=created.data.ids.map(id=>({id,version:1}));
  const rows=()=>request(path,'GET',undefined,owner.cookie);
  const count=async()=> (await rows()).data.schedules.length;
  assert.equal((await request(path+'/bulk-delete','POST',{items},'')).status,401);
  assert.equal((await request(path+'/bulk-delete','POST',{items:[items[0],{id:foreign.data.id,version:1}]},member.cookie)).status,403);
  assert.equal(await count(),4);
  for(const invalid of [[],[items[0],items[0]],[{id:items[0].id,version:'1'}],[null]]){
   assert.equal((await request(path+'/bulk-delete','POST',{items:invalid},member.cookie)).status,400);
   assert.equal(await count(),4);
  }
  assert.equal((await request(path+'/'+items[1].id,'PATCH',{title:'수정된 수업',version:1},member.cookie)).status,200);
  assert.equal((await request(path+'/bulk-delete','POST',{items},member.cookie)).status,409);
  assert.equal(await count(),4);
  assert.equal((await request(path+'/bulk-delete','POST',{items:[items[0],{id:'missing',version:1}]},member.cookie)).status,409);
  assert.equal(await count(),4);
  const otherProject=await request('/projects','POST',{name:'별도 프로젝트',nickname:'별도 방장'});
  assert.equal((await request(`/projects/${otherProject.data.projectId}/schedules/bulk-delete`,'POST',{items},member.cookie)).status,403);
  items[1].version=2;
  const body={items,requestId:'bulk-delete-a'};
  const deleted=await request(path+'/bulk-delete','POST',body,member.cookie);assert.equal(deleted.status,200);assert.equal(deleted.data.deleted,3);
  assert.equal(await count(),1);
  assert.deepEqual((await request(path+'/bulk-delete','POST',body,member.cookie)).data,deleted.data);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE entity='schedule' AND action='deleted'").get().n,3);
  // Removing a date entry preserves its exception day and availability confirmation.
  const dated=await request(path,'POST',{kind:'date',date:'2026-10-12',start_min:1380,end_min:1860,status:'unavailable'},member.cookie);
  await request(`/projects/${owner.data.projectId}/confirmations`,'POST',{start_date:'2026-10-12',end_date:'2026-10-12'},member.cookie);
  const before=(await rows()).data;
  const removedDate=await request(path+'/bulk-delete','POST',{items:[{id:dated.data.id,version:1}]},member.cookie);assert.equal(removedDate.status,200);
  const after=(await rows()).data;
  assert.deepEqual(after.exceptions,before.exceptions);assert.deepEqual(after.confirmations,before.confirmations);assert.equal(after.meetings.length,before.meetings.length);
  assert.equal(after.schedules.length,1);assert.equal(after.schedules[0].id,foreign.data.id);
 }finally{await new Promise(r=>server.close(r));db.close()}
});
