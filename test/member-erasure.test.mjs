import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {existsSync,unlinkSync} from 'node:fs';
import {openDb} from '../db.mjs';
import {createApp} from '../server.mjs';
import {eraseMembers,eraseInactiveMembers} from '../member-cleanup.mjs';

async function fixture(){
 const db=openDb(':memory:'),server=createApp(db);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,method='GET',body,cookie='')=>{
  const r=await fetch(base+'/api'+path,{method,headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
 };
 const owner=await request('/projects','POST',{name:'삭제 검증',nickname:'Owner'});
 const target=await request('/join','POST',{code:owner.data.inviteCode,nickname:'ErasedPerson'});
 const survivor=await request('/join','POST',{code:owner.data.inviteCode,nickname:'Survivor'});
 const project=owner.data.projectId,path=`/projects/${project}`;
 const ownerId=(await request('/me','GET',undefined,owner.cookie)).data.id;
 const targetId=(await request('/me','GET',undefined,target.cookie)).data.id;
 const survivorId=(await request('/me','GET',undefined,survivor.cookie)).data.id;
 return {db,server,request,owner,target,survivor,project,path,ownerId,targetId,survivorId,close:async()=>{await new Promise(r=>server.close(r));db.close()}};
}

test('멤버 영구 삭제는 개인 기록·인증·캐시를 지우고 공동 과제·다른 멤버·다른 프로젝트를 유지',async()=>{
 const f=await fixture(),{db,request,owner,target,survivor,path,project,ownerId,targetId,survivorId}=f;
 try{
  const parent=await request(path+'/tasks','POST',{title:'공동 조사',requestId:'target-task'},target.cookie);
  const child=await request(path+'/tasks','POST',{title:'결과 정리',parent_id:parent.data.id},target.cookie);
  await request(path+'/tasks/'+parent.data.id,'PATCH',{version:1,lead_id:targetId},owner.cookie);
  const role=await request(path+'/roles','POST',{task_id:child.data.id,member_id:targetId,description:'원자료 정리',estimate:2},owner.cookie);
  const otherRole=await request(path+'/roles','POST',{task_id:child.data.id,member_id:ownerId,description:'팀 검토',estimate:1},owner.cookie);
  await request(path+'/roles/'+role.data.id,'PATCH',{version:1,status:'done'},target.cookie);
  db.prepare('UPDATE roles SET updated_by=? WHERE id=?').run(targetId,otherRole.data.id);
  await request(path+'/comments','POST',{task_id:child.data.id,body:'개인 댓글'},target.cookie);
  await request(path+'/comments','POST',{task_id:child.data.id,body:'공동 검토 댓글'},survivor.cookie);
  const schedule={kind:'weekly',days:[1],start_min:540,end_min:780,status:'available',title:'일정',requestId:'target-schedule'};
  const targetSchedule=await request(path+'/schedules','POST',schedule,target.cookie);
  await request(path+'/schedules','POST',{...schedule,requestId:'owner-schedule'},owner.cookie);
  await request(path+'/exceptions','POST',{date:'2026-10-13'},target.cookie);
  await request(path+'/confirmations','POST',{start_date:'2026-10-12',end_date:'2026-10-18'},target.cookie);
  const options={selected:[ownerId,targetId],required:[targetId],startDate:'2026-10-12',endDate:'2026-10-12',duration:60,from:540,to:780,mode:'all',topN:5};
  assert.equal((await request(path+'/recommend','POST',options,owner.cookie)).status,200);
  const meeting=await request(path+'/meetings','POST',{...options,date:'2026-10-12',start:'09:00',end:'10:00',attendees:[ownerId,targetId],title:'팀 회의'},owner.cookie);assert.equal(meeting.status,201);
  const solo=await request(path+'/meetings','POST',{...options,selected:[targetId],date:'2026-10-12',start:'11:00',end:'12:00',attendees:[targetId],title:'단독 회의'},owner.cookie);assert.equal(solo.status,201);
  db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),project,ownerId,'role',role.data.id,'assignee_changed',`${targetId} → ${ownerId}`,new Date().toISOString());
  db.prepare('INSERT INTO idempotency VALUES (?,?,?,?,?)').run(`schedule-edit:${ownerId}:${targetSchedule.data.id}`,'old-cache',JSON.stringify({id:targetId}),null,200);
  db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,NULL)').run(randomUUID(),ownerId,`role:${role.data.id}:due:old`,'옛 담당 역할 알림',new Date().toISOString());
  const other=await request('/projects','POST',{name:'다른 팀',nickname:'OtherOwner'});
  const otherSnapshot=JSON.stringify(db.prepare('SELECT * FROM members WHERE project_id=?').all(other.data.projectId));
  assert.equal((await request(path+'/members/'+targetId,'DELETE',{},owner.cookie)).status,400);
  assert.equal((await request(path+'/members/'+targetId,'DELETE',{confirm_permanent:true},survivor.cookie)).status,403);
  assert.equal((await request(`/projects/${other.data.projectId}/members/${targetId}`,'DELETE',{confirm_permanent:true},other.cookie)).status,404);
  assert.equal((await request(path+'/members/'+ownerId,'DELETE',{confirm_permanent:true},owner.cookie)).status,400);
  assert.throws(()=>eraseMembers(db,project,[targetId,ownerId]));
  assert.ok(db.prepare('SELECT id FROM members WHERE id=?').get(targetId));
  const erased=await request(path+'/members/'+targetId,'DELETE',{confirm_permanent:true},owner.cookie);assert.equal(erased.status,200);
  assert.equal((await request('/me','GET',undefined,target.cookie)).data,null);
  assert.equal((await request('/recover','POST',{code:target.data.recoveryCode})).status,404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM members WHERE id=?').get(targetId).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM roles WHERE member_id=?').get(targetId).n,0);
  assert.equal(db.prepare('SELECT creator_id FROM tasks WHERE id=?').get(parent.data.id).creator_id,null);
  assert.equal(db.prepare('SELECT lead_id FROM tasks WHERE id=?').get(parent.data.id).lead_id,null);
  assert.equal(db.prepare('SELECT updated_by FROM roles WHERE id=?').get(otherRole.data.id).updated_by,null);
  assert.equal(db.prepare('SELECT status FROM meetings WHERE id=?').get(meeting.data.id).status,'confirmed');
  assert.equal(db.prepare('SELECT status FROM meetings WHERE id=?').get(solo.data.id).status,'cancelled');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM members WHERE project_id=?').all(other.data.projectId)),otherSnapshot);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  // Verify all application tables, not just the member management response.
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
   const rows=JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all());
   assert.ok(!rows.includes(targetId),`ID remains in ${name}`);assert.ok(!rows.includes('ErasedPerson'),`Nickname remains in ${name}`);
  }
  for(const suffix of ['', '/tasks','/schedules','/meetings','/comments/'+child.data.id,'/audit','/preferences','/notifications']){
   const response=await request(path+suffix,'GET',undefined,owner.cookie);assert.equal(response.status,200);assert.ok(!JSON.stringify(response.data).includes(targetId));
  }
  assert.deepEqual((await request(path+'/preferences','GET',undefined,owner.cookie)).data.selected,[ownerId]);
  const tasks=(await request(path+'/tasks','GET',undefined,owner.cookie)).data;
  assert.equal(tasks.roles.length,1);assert.equal(tasks.progress,0);assert.equal(tasks.tasks.length,2);
  assert.equal((await request(path+'/comments/'+child.data.id,'GET',undefined,owner.cookie)).data[0].member_id,survivorId);
  // Nickname reuse creates a new identity with none of the old person's access.
  const rejoined=await request('/join','POST',{code:owner.data.inviteCode,nickname:'ErasedPerson'});assert.equal(rejoined.status,201);
  const newId=(await request('/me','GET',undefined,rejoined.cookie)).data.id;assert.notEqual(newId,targetId);
  const left=await request(path+'/members/'+newId,'DELETE',{confirm_permanent:true},rejoined.cookie);assert.equal(left.status,200);assert.equal(left.cookie,'tt_session=');
  assert.equal((await request('/me','GET',undefined,rejoined.cookie)).data,null);
 }finally{await f.close()}
});

test('기존 비활성 멤버 정리는 방장 확인을 요구하고 같은 프로젝트만 정리',async()=>{
 const f=await fixture(),{db,request,path,project,owner,target,survivor,targetId}=f;
 try{
  const task=await request(path+'/tasks','POST',{title:'기존 공동 과제'},target.cookie);
  db.prepare('UPDATE members SET active=0 WHERE id=?').run(targetId);
  const other=await request('/projects','POST',{name:'별도 프로젝트',nickname:'AnotherOwner'});
  const oldId=randomUUID();db.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?)').run(oldId,other.data.projectId,'LegacyOther','member','hash',0,new Date().toISOString());
  assert.equal((await request(path+'/members/cleanup','POST',{confirm_permanent:true},survivor.cookie)).status,403);
  assert.equal((await request(path+'/members/cleanup','POST',{},owner.cookie)).status,400);
  const before=(await request(path,'GET',undefined,owner.cookie)).data;
  assert.equal(before.inactive_member_count,1);assert.ok(!before.members.some(m=>m.id===targetId));
  const cleaned=await request(path+'/members/cleanup','POST',{confirm_permanent:true},owner.cookie);assert.equal(cleaned.status,200);assert.equal(cleaned.data.deleted,1);
  assert.equal(db.prepare('SELECT creator_id FROM tasks WHERE id=?').get(task.data.id).creator_id,null);
  assert.ok(db.prepare('SELECT id FROM members WHERE id=?').get(oldId));
  assert.equal((await request(path+'/members/cleanup','POST',{confirm_permanent:true},owner.cookie)).data.deleted,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM members WHERE project_id=?').get(project).n,2);
 }finally{await f.close()}
});

test('기존 DB의 필수 작성자 필드를 전환할 때 과제 트리·역할·회의 참조와 인덱스를 보존',()=>{
 const filename=join(tmpdir(),`teamtime-author-migration-${randomUUID()}.sqlite`);
 let db;
 try{
  const schemaDb=openDb(':memory:');
  const schema=schemaDb.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC").all().map(x=>x.sql.replace('creator_id TEXT REFERENCES','creator_id TEXT NOT NULL REFERENCES').replace('created_by TEXT REFERENCES','created_by TEXT NOT NULL REFERENCES')).join(';');schemaDb.close();
  db=new DatabaseSync(filename);db.exec(schema);
  const time=new Date().toISOString();
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)').run('p','Legacy','',null,'Asia/Seoul','hash',1,1,time);
  for(const [id,role,active] of [['owner','owner',1],['old','member',0]])db.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?)').run(id,'p',id,role,'hash',active,time);
  for(const [id,parent] of [['root',null],['leaf','root']])db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'p',parent,'old',null,id,'','normal',null,null,null,null,'',0,1,time,time);
  db.prepare('INSERT INTO roles VALUES (?,?,?,?,?,?,?,?,?)').run('role','leaf','owner','Review',1,'todo',1,time,'owner');
  db.prepare('INSERT INTO meetings VALUES (?,?,?,?,?,?,?,?,?,?)').run('meeting','p','Legacy meeting','','2026-10-12T09:00:00','2026-10-12T10:00:00','confirmed',1,'old',time);
  db.prepare('INSERT INTO meeting_attendees VALUES (?,?)').run('meeting','owner');db.close();
  db=openDb(filename);
  assert.equal(db.prepare('PRAGMA table_info(tasks)').all().find(x=>x.name==='creator_id').notnull,0);
  assert.equal(db.prepare('PRAGMA table_info(meetings)').all().find(x=>x.name==='created_by').notnull,0);
  assert.equal(db.prepare('SELECT parent_id FROM tasks WHERE id=?').get('leaf').parent_id,'root');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='tasks_project'").get());
  assert.equal(eraseInactiveMembers(db,'p').deleted,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,2);
  assert.equal(db.prepare('SELECT created_by FROM meetings').get().created_by,null);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();db=openDb(filename);assert.equal(db.prepare('SELECT COUNT(*) n FROM roles').get().n,1);
 }finally{
  if(db?.isOpen)db.close();
  for(const suffix of ['','-wal','-shm'])if(existsSync(filename+suffix))unlinkSync(filename+suffix);
 }
});
