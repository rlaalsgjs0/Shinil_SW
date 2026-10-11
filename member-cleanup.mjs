const all=(db,sql,...args)=>db.prepare(sql).all(...args);
const run=(db,sql,...args)=>db.prepare(sql).run(...args);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};

export function eraseMembers(db,projectId,memberIds){
 const ids=[...new Set(memberIds)];if(!ids.length)return {deleted:0};
 db.exec('BEGIN IMMEDIATE;');
 try{
  const targets=ids.map(id=>db.prepare('SELECT * FROM members WHERE id=? AND project_id=?').get(id,projectId));
  if(targets.some(x=>!x))fail(404,'멤버를 찾을 수 없습니다.');
  if(targets.some(x=>x.role==='owner'))fail(400,'방장은 삭제할 수 없습니다.');
  for(const member of targets)eraseMemberRecords(db,projectId,member.id);
  if(all(db,'PRAGMA foreign_key_check').length)throw Error('Member erasure left invalid references');
  db.exec('COMMIT;');return {deleted:targets.length};
 }catch(error){db.exec('ROLLBACK;');throw error;}
}

export function eraseInactiveMembers(db,projectId){
 return eraseMembers(db,projectId,all(db,"SELECT id FROM members WHERE project_id=? AND active=0 AND role!='owner'",projectId).map(x=>x.id));
}

function eraseMemberRecords(db,projectId,memberId){
 const timestamp=new Date().toISOString();
 const personalIds=[memberId,
  ...all(db,'SELECT id FROM schedules WHERE member_id=?',memberId).map(x=>x.id),
  ...all(db,'SELECT id FROM availability_confirmations WHERE member_id=?',memberId).map(x=>x.id),
  ...all(db,'SELECT id FROM roles WHERE member_id=?',memberId).map(x=>x.id),
  ...all(db,'SELECT id FROM comments WHERE member_id=?',memberId).map(x=>x.id)];
 // Erase histories about the person and their deleted records, even when
 // another member performed an assignment or schedule change.
 for(const recordId of personalIds){
  run(db,'DELETE FROM audit WHERE project_id=? AND (member_id=? OR entity_id=? OR instr(detail,?)>0)',projectId,memberId,recordId,recordId);
  run(db,'DELETE FROM idempotency WHERE instr(scope,?)>0 OR instr(response,?)>0 OR instr(key,?)>0',recordId,recordId,recordId);
  run(db,'DELETE FROM notifications WHERE member_id IN (SELECT id FROM members WHERE project_id=?) AND instr(event_key,?)>0',projectId,recordId);
 }
 // Shared tasks retain their content, with no substitute author identity.
 run(db,`UPDATE tasks SET creator_id=CASE WHEN creator_id=? THEN NULL ELSE creator_id END,
  lead_id=CASE WHEN lead_id=? THEN NULL ELSE lead_id END,version=version+1,updated_at=?
  WHERE project_id=? AND (creator_id=? OR lead_id=? OR id IN (SELECT task_id FROM roles WHERE member_id=?))`,memberId,memberId,timestamp,projectId,memberId,memberId,memberId);
 run(db,'DELETE FROM roles WHERE member_id=?',memberId);
 run(db,'UPDATE roles SET updated_by=NULL,version=version+1,updated_at=? WHERE updated_by=?',timestamp,memberId);
 const affectedMeetings=all(db,'SELECT id FROM meetings WHERE project_id=? AND (created_by=? OR id IN (SELECT meeting_id FROM meeting_attendees WHERE member_id=?))',projectId,memberId,memberId);
 run(db,`UPDATE meetings SET created_by=CASE WHEN created_by=? THEN NULL ELSE created_by END,version=version+1,updated_at=?
  WHERE project_id=? AND (created_by=? OR id IN (SELECT meeting_id FROM meeting_attendees WHERE member_id=?))`,memberId,timestamp,projectId,memberId,memberId);
 run(db,'DELETE FROM meeting_attendees WHERE member_id=?',memberId);
 for(const meeting of affectedMeetings)run(db,"UPDATE meetings SET status='cancelled' WHERE id=? AND status='confirmed' AND NOT EXISTS(SELECT 1 FROM meeting_attendees a WHERE a.meeting_id=meetings.id)",meeting.id);
 // Other members' recommendation settings must not keep the erased ID.
 for(const pref of all(db,'SELECT p.* FROM preferences p JOIN members m ON m.id=p.member_id WHERE m.project_id=? AND m.id!=?',projectId,memberId)){
  const data=JSON.parse(pref.data);
  for(const key of ['selected','required'])if(Array.isArray(data[key]))data[key]=data[key].filter(id=>id!==memberId);
  run(db,'UPDATE preferences SET data=? WHERE member_id=?',JSON.stringify(data),pref.member_id);
 }
 for(const table of ['sessions','schedules','date_exceptions','availability_confirmations','comments','notifications','preferences'])run(db,`DELETE FROM ${table} WHERE member_id=?`,memberId);
 run(db,'DELETE FROM members WHERE id=? AND project_id=?',memberId,projectId);
 // Deliberately do not create a "removed member" audit entry.
}
