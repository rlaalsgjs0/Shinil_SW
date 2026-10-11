import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarSegments, layoutCalendarEvents, renderCalendar, calendarTime, SCHEDULE_COLORS } from '../public/calendar.js';
import { slotState as intervalState } from '../logic.mjs';
const slotState = (data, member, date, start) => intervalState(data, member, date, start, start + 30);

const empty = () => ({ schedules: [], exceptions: [], confirmations: [], meetings: [] });
const schedule = (fields = {}) => ({ id: 'a', member_id: 'me', kind: 'weekly', day: 1, start_min: 570, end_min: 660, status: 'unavailable', title: '수업', ...fields });

test('24시간을 1시간 눈금으로 렌더링하고 30분 시작을 정확한 막대 위치로 표시', () => {
 const data = empty();data.schedules.push(schedule());
 const html = renderCalendar({ data, memberId: 'me', dates: ['2026-10-12'], single: true });
 assert.equal((html.match(/class="calendar-hour"/g) || []).length, 24);
 assert.equal((html.match(/class="calendar-hour-label/g) || []).length, 25);
 assert.match(html, />00:00<\/span>/);assert.match(html, />24:00<\/span>/);
 assert.match(html, /data-min="1380"/);assert.match(html, /09:30~11:00/);
 assert.match(html, /top:39\.583333333333336%;height:6\.25%/);
 assert.match(html, /calendar-event unavailable/);
 assert.equal(calendarTime(1440), '24:00');
 assert.notEqual(SCHEDULE_COLORS.available,SCHEDULE_COLORS.unavailable);
});

test('자정을 넘는 취침은 원래 일정 ID를 유지하며 두 날짜에 나누어 표시', () => {
 const data = empty();data.schedules.push(schedule({kind:'sleep',start_min:1380,end_min:1860}));
 const first=calendarSegments(data,'me','2026-10-12'),next=calendarSegments(data,'me','2026-10-13');
 assert.deepEqual(first.map(x=>[x.id,x.start,x.end,x.status,x.continuation]),[['a',1380,1440,'unavailable',false]]);
 assert.deepEqual(next.map(x=>[x.id,x.start,x.end,x.status,x.continuation]),[['a',0,420,'unavailable',true]]);
 assert.equal(calendarSegments(data,'other','2026-10-13').length,0);
});

test('날짜 예외와 기피 시간은 서버의 반복 일정 적용 방식과 일치', () => {
 const data=empty();data.exceptions.push({member_id:'me',date:'2026-10-12'});
 data.schedules.push(schedule(),schedule({id:'date',kind:'date',date:'2026-10-12',start_min:600,end_min:630,status:'available'}),schedule({id:'avoid',kind:'avoid',start_min:720,end_min:780}));
 const segments=calendarSegments(data,'me','2026-10-12');
 assert.deepEqual(segments.map(x=>x.id),['date','avoid']);
 assert.equal(segments.find(x=>x.id==='avoid').status,'avoid');
 assert.equal(slotState(data,'me','2026-10-12',570),'unknown');
 assert.equal(slotState(data,'me','2026-10-12',600),'available');
});

test('미입력은 녹색으로 칠하지 않고 확인한 기간의 가능 시간만 표시', () => {
 const data=empty();data.confirmations.push({member_id:'me',start_date:'2026-10-12',end_date:'2026-10-12'});
 const render=date=>renderCalendar({data,memberId:'me',dates:[date],getStatus:(date,start)=>slotState(data,'me',date,start)});
 assert.match(render('2026-10-12'),/calendar-available-background.*height:100%/);
 assert.doesNotMatch(render('2026-10-13'),/calendar-available-background/);
});

test('겹친 일정은 각각 표시하고 자정을 넘는 확정 회의는 양 날짜에 표시', () => {
 const events=layoutCalendarEvents([{start:540,end:660},{start:570,end:630},{start:660,end:720}]);
 assert.deepEqual(events.map(x=>[x.lane,x.lanes]),[[0,2],[1,2],[0,1]]);
 const data=empty();data.meetings.push({id:'meeting',title:'회의',status:'confirmed',attendees:['me'],start_at:'2026-10-12T23:30:00',end_at:'2026-10-13T00:30:00'});
 assert.deepEqual(calendarSegments(data,'me','2026-10-12').map(x=>[x.start,x.end,x.source]),[[1410,1440,'meeting']]);
 assert.deepEqual(calendarSegments(data,'me','2026-10-13').map(x=>[x.start,x.end]),[[0,30]]);
 assert.match(renderCalendar({data,memberId:'me',dates:['2026-10-12']}),/data-action="calendar-meeting"/);
});

test('일정 이름은 HTML로 실행되지 않도록 이스케이프', () => {
 const data=empty();data.schedules.push(schedule({title:'<img src=x onerror="alert(1)">'}));
 const html=renderCalendar({data,memberId:'me',dates:['2026-10-12']});
 assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
});

test('선택 모드는 개인 일정만 선택하고 자정을 넘긴 두 막대의 선택 표시를 일치시킨다',()=>{
 const data=empty();data.schedules.push(schedule({start_min:1380,end_min:1500}));
 data.meetings.push({id:'meeting',title:'회의',status:'confirmed',attendees:['me'],start_at:'2026-10-12T12:00:00',end_at:'2026-10-12T13:00:00'});
 const options={data,memberId:'me',dates:['2026-10-12','2026-10-13'],selectionMode:true,selectedScheduleIds:new Set(['a'])};
 const html=renderCalendar(options);
 assert.equal((html.match(/data-action="select-schedule"/g)||[]).length,2);
 assert.equal((html.match(/aria-pressed="true"/g)||[]).length,2);
 assert.match(html,/data-action="calendar-meeting" data-id="meeting"\s+disabled/);
 assert.match(html,/data-step="60" disabled/);
 assert.match(html,/☑ 수업/);
 const busy=renderCalendar({...options,selectionBusy:true});
 assert.equal((busy.match(/aria-pressed="true" disabled/g)||[]).length,2);
 const ordinary=renderCalendar({...options,selectionMode:false});
 assert.match(ordinary,/data-action="edit-schedule"/);assert.doesNotMatch(ordinary,/aria-pressed=/);
});
