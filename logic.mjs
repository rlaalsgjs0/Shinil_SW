export const isoDate = d => new Date(d).toISOString().slice(0,10);
export const addDays = (date,n) => isoDate(new Date(`${date}T12:00:00Z`).getTime()+n*86400000);
export const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
export const minutes = time => { const [h,m]=String(time).split(':').map(Number); return h*60+m; };
export const hhmm = n => n===1440?'24:00':`${String(Math.floor(n/60)%24).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
export function taskStatus(roles) {
  if (!roles.length||roles.every(r=>!r.member_id)) return 'unassigned';
  if (roles.every(r=>r.status==='done')) return 'done';
  if (roles.some(r=>r.status==='blocked' && r.status!=='done')) return 'blocked';
  if (roles.filter(r=>r.status!=='done').every(r=>r.status==='review')) return 'review';
  if (roles.some(r=>r.status!=='todo')) return 'doing';
  return 'todo';
}
export function progress(tasks, roles, rootId = null) {
  const children = id => tasks.filter(t=>t.parent_id===id);
  const leaves = id => { const own=children(id); return own.flatMap(t => children(t.id).length ? leaves(t.id) : [t]); };
  const list = leaves(rootId);
  if (!list.length) return null;
  return list.reduce((n,t)=>{const rs=roles.filter(r=>r.task_id===t.id);return n+(rs.length?rs.filter(r=>r.status==='done').length/rs.length:0);},0)/list.length;
}
function intersects(a,b,c,d){return a<d && b>c;}
function intervals(s,date,exceptions) {
  const previous=addDays(date,-1),currentException=exceptions.some(e=>e.member_id===s.member_id&&e.date===date),previousException=exceptions.some(e=>e.member_id===s.member_id&&e.date===previous);
  const allowed=(source,except)=>['sleep','avoid'].includes(s.kind)||s.kind===(except?'date':'weekly');
  const out=[];
  if(allowed(date,currentException)&&(s.kind==='date'?s.date===date:s.day===weekday(date)))out.push([s.start_min,s.end_min]);
  if(s.end_min>1440&&allowed(previous,previousException)&&(s.kind==='date'?s.date===previous:s.day===weekday(previous)))out.push([s.start_min-1440,s.end_min-1440]);
  return out;
}
function covers(intervals,from,to){let edge=from;for(const [a,b] of intervals.sort((x,y)=>x[0]-y[0])){if(a>edge)break;edge=Math.max(edge,b);if(edge>=to)return true;}return false;}
export function slotState({schedules,exceptions,confirmations,meetings},memberId,date,from,to) {
  const segments=schedules.filter(s=>s.member_id===memberId).flatMap(s=>intervals(s,date,exceptions).map(([a,b])=>({s,a,b}))).filter(x=>intersects(x.a,x.b,from,to));
  const start=`${date}T${hhmm(from)}:00`;
  const end=to===1440?`${addDays(date,1)}T00:00:00`:`${date}T${hhmm(to)}:00`;
  const busyMeeting=meetings.some(m=>m.status==='confirmed'&&m.attendees.includes(memberId)&&m.start_at<end&&m.end_at>start);
  if (busyMeeting||segments.some(x=>x.s.kind==='sleep'||x.s.status==='unavailable')) return 'unavailable';
  const confirmed=confirmations.some(c=>c.member_id===memberId&&c.start_date<=date&&c.end_date>=date);
  const available=segments.filter(x=>x.s.status==='available').map(x=>[x.a,x.b]);
  const avoid=segments.filter(x=>x.s.kind==='avoid'||x.s.status==='avoid').map(x=>[x.a,x.b]);
  if (avoid.length&&segments.some(x=>(x.s.kind==='avoid'||x.s.status==='avoid'))) return confirmed||covers([...available,...avoid],from,to)?'avoid':'unknown';
  if (confirmed||covers(available,from,to)) return 'available';
  return 'unknown';
}
export function windowState(data,memberId,date,from,duration,includeAvoid=false) {
  let avoided=false,unknown=false,unavailable=false;
  for(let n=from;n<from+duration;n+=30){
    const st=slotState(data,memberId,date,n,n+30);
    if(st==='unknown') unknown=true;
    if(st==='unavailable'||(st==='avoid'&&!includeAvoid)) unavailable=true;
    if(st==='avoid') avoided=true;
  }
  if(unavailable)return {status:'unavailable'};
  if(unknown)return {status:'unknown'};
  return {status:'available',avoided};
}
export function recommend(data, selected, opts) {
  const {startDate,endDate,duration=60,from=540,to=1320,topN=5,weekends=false,includeAvoid=false,mode='all',required=[],overlap=false}=opts;
  if(!selected.length) return [];
  const result=[];
  for(let date=startDate;date<=endDate;date=addDays(date,1)){
    const day=weekday(date); if(!weekends&&(day===0||day===6)) continue;
    for(let n=from;n+duration<=to;n+=30){
      const states=selected.map(id=>({id,...windowState(data,id,date,n,duration,includeAvoid)}));
      const attending=states.filter(s=>s.status==='available').map(s=>s.id);
      if(!attending.length||required.some(id=>!attending.includes(id))||(mode==='all'&&attending.length!==selected.length)) continue;
      result.push({date,start:hhmm(n),end:hhmm(n+duration),startMin:n,endMin:n+duration,attending,unavailable:states.filter(s=>s.status==='unavailable').map(s=>s.id),unknown:states.filter(s=>s.status==='unknown').map(s=>s.id),avoidCount:states.filter(s=>s.avoided).length,total:selected.length});
    }
  }
  result.sort((a,b)=>b.attending.length-a.attending.length||a.avoidCount-b.avoidCount||a.date.localeCompare(b.date)||a.startMin-b.startMin);
  const picked=[];
  for(const r of result){if(!overlap&&picked.some(p=>p.date===r.date&&intersects(p.startMin,p.endMin,r.startMin,r.endMin)))continue;picked.push(r);if(picked.length>=topN)break;}
  return picked;
}
