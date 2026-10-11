import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../db.mjs';
import {createApp} from '../server.mjs';

test('두 세션의 협업, 권한, 충돌, 회의 재검사',async()=>{
 const db=openDb(':memory:'),server=createApp(db);await new Promise(r=>server.listen(0,r));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,method='GET',body,cookie=''){const r=await fetch(base+'/api'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''}}
 try{
  const created=await request('/projects','POST',{name:'팀 A',nickname:'방장',requestId:'create-a'});assert.equal(created.status,201);const owner=created.cookie,p=created.data.projectId;
  const repeated=await request('/projects','POST',{name:'팀 A',nickname:'방장',requestId:'create-a'});assert.equal(repeated.data.projectId,p);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM idempotency WHERE scope='create'").get().n,0);
  const join=await request('/join','POST',{code:created.data.inviteCode,nickname:'조원'});assert.equal(join.status,201);const member=join.cookie;
  assert.equal((await request('/join','POST',{code:created.data.inviteCode,nickname:'조원'})).status,409);
  assert.equal((await request('/recover','POST',{code:'조원'})).status,404);
  const recovered=await request('/recover','POST',{code:join.data.recoveryCode});assert.equal(recovered.status,200);assert.notEqual(recovered.data.recoveryCode,join.data.recoveryCode);
  assert.equal((await request('/recover','POST',{code:join.data.recoveryCode})).status,404);
  const activeMember=recovered.cookie;
  assert.equal((await request(`/projects/${p}`,'GET',undefined,member)).status,401);
  const other=await request('/projects','POST',{name:'팀 B',nickname:'방장'});assert.equal((await request(`/projects/${other.data.projectId}`,'GET',undefined,activeMember)).status,403);
  const projectResponse=(await request(`/projects/${p}`,'GET',undefined,owner)).data;assert.equal('recovery_hash' in projectResponse.member,false);assert.equal('invite_hash' in projectResponse,false);const members=projectResponse.members,ownerId=members.find(x=>x.role==='owner').id,memberId=members.find(x=>x.role==='member').id;
  const sched={kind:'weekly',day:1,start_min:540,end_min:660,status:'available',title:'비밀 수업'};
  const s=await request(`/projects/${p}/schedules`,'POST',sched,activeMember);assert.equal(s.status,201);
  const visible=(await request(`/projects/${p}/schedules`,'GET',undefined,owner)).data;assert.equal(visible.schedules.find(x=>x.id===s.data.id).title,'');
  assert.equal((await request(`/projects/${p}/schedules/${s.data.id}`,'PATCH',{...sched,version:1,title:'변경'},owner)).status,403);
  assert.equal((await request(`/projects/${p}/schedules/${s.data.id}`,'PATCH',{...sched,version:1,title:'변경'},activeMember)).status,200);
  assert.equal((await request(`/projects/${p}/schedules/${s.data.id}`,'PATCH',{...sched,version:1,title:'구버전'},activeMember)).status,409);
  const task=await request(`/projects/${p}/tasks`,'POST',{title:'조사',target_date:'2026-10-15',due_date:'2026-10-14'},activeMember);assert.equal(task.status,400);
  const good=await request(`/projects/${p}/tasks`,'POST',{title:'조사',target_date:'2026-10-14',due_date:'2026-10-15',requestId:'task-a'},activeMember);assert.equal(good.status,201);assert.equal((await request(`/projects/${p}/tasks`,'POST',{title:'조사',requestId:'task-a'},activeMember)).data.id,good.data.id);
  assert.equal((await request(`/projects/${p}/tasks`,'POST',{title:'대표 지정 시도',lead_id:ownerId},activeMember)).status,403);
  const ownerTask=await request(`/projects/${p}/tasks`,'POST',{title:'방장 과제'},owner);assert.equal(ownerTask.status,201);
  assert.equal((await request(`/projects/${p}/tasks`,'POST',{title:'무단 하위',parent_id:ownerTask.data.id},activeMember)).status,403);
  assert.equal((await request(`/projects/${p}/tasks/${good.data.id}`,'PATCH',{version:1,title:'조사',lead_id:ownerId},owner)).status,200);
  assert.equal((await request(`/projects/${p}/tasks/${good.data.id}`,'PATCH',{version:2,title:'조사 수정'},activeMember)).status,200);
  const role=await request(`/projects/${p}/roles`,'POST',{task_id:good.data.id,member_id:memberId,description:'자료 조사',estimate:2},owner);assert.equal(role.status,201);
  const secondRole=await request(`/projects/${p}/roles`,'POST',{task_id:good.data.id,member_id:ownerId,description:'정리',estimate:1},owner);assert.equal(secondRole.status,201);
  assert.equal((await request(`/projects/${p}/roles/${role.data.id}`,'PATCH',{version:1,status:'doing'},activeMember)).status,200);
  assert.equal((await request(`/projects/${p}/roles/${role.data.id}`,'PATCH',{version:2,member_id:ownerId},activeMember)).status,403);
  const roleBundle=(await request(`/projects/${p}/tasks`,'GET',undefined,owner)).data;assert.equal(roleBundle.roles.length,2);assert.equal(roleBundle.roles.find(x=>x.id===secondRole.data.id).status,'todo');assert.equal(roleBundle.tasks.find(x=>x.id===good.data.id).status,'doing');
  assert.equal((await request(`/projects/${p}/roles/${role.data.id}`,'PATCH',{version:1,status:'done'},owner)).status,409);
  await request(`/projects/${p}/schedules`,'POST',{kind:'weekly',day:1,start_min:540,end_min:660,status:'available'},owner);
  const options={selected:[ownerId,memberId],required:[],startDate:'2026-10-12',endDate:'2026-10-12',duration:60,from:540,to:660,mode:'all',topN:5};
  const rec=await request(`/projects/${p}/recommend`,'POST',options,owner);assert.equal(rec.data.items.length,2);
  const blocked=await request(`/projects/${p}/schedules`,'POST',{kind:'date',date:'2026-10-12',start_min:570,end_min:600,status:'unavailable'},activeMember);assert.equal(blocked.status,201);
  const meeting=await request(`/projects/${p}/meetings`,'POST',{...options,date:'2026-10-12',start:'09:00',end:'10:00',attendees:[ownerId,memberId],title:'회의'},owner);assert.equal(meeting.status,409);
  assert.equal((await request(`/projects/${p}/schedules/${blocked.data.id}`,'DELETE',{version:1},activeMember)).status,200);
  assert.equal((await request(`/projects/${p}/exceptions/2026-10-12`,'DELETE',{},activeMember)).status,200);
  const meetingBody={...options,date:'2026-10-12',start:'09:00',end:'10:00',attendees:[ownerId,memberId],title:'회의',requestId:'meeting-a'};
  const confirmed=await request(`/projects/${p}/meetings`,'POST',meetingBody,owner);assert.equal(confirmed.status,201);
  assert.equal((await request(`/projects/${p}/meetings`,'POST',meetingBody,owner)).data.id,confirmed.data.id);
  const afterMeeting=await request(`/projects/${p}/recommend`,'POST',options,owner);assert.equal(afterMeeting.data.items.some(x=>x.start==='09:00'),false);
  const changed=await request(`/projects/${p}/meetings/${confirmed.data.id}`,'PATCH',{version:1,title:'변경 회의',date:'2026-10-12',start:'10:00',end:'11:00',attendees:[ownerId,memberId]},owner);assert.equal(changed.status,200);
  assert.equal((await request(`/projects/${p}/meetings/${confirmed.data.id}`,'PATCH',{version:2,cancel:true},activeMember)).status,403);
  assert.equal((await request(`/projects/${p}/meetings/${confirmed.data.id}`,'PATCH',{version:2,cancel:true},owner)).status,200);
 }finally{await new Promise(r=>server.close(r));db.close()}
});
