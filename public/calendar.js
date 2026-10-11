const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export const SCHEDULE_COLORS = { available: '#22a563', unavailable: '#df515c', avoid: '#e8b82f' };
const LABELS = { available: '가능', unavailable: '불가능', avoid: '기피' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const dateValue = date => new Date(`${date}T12:00:00Z`).getTime();
const previousDate = date => new Date(dateValue(date) - 86400000).toISOString().slice(0, 10);
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
export const calendarTime = minute => minute === 1440 ? '24:00' : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

// Build only the portions that are visible on this date; overnight entries keep
// their original ID so clicking either portion edits the same personal schedule.
export function calendarSegments(data, memberId, date) {
  const previous = previousDate(date);
  const hasException = source => data.exceptions.some(item => item.member_id === memberId && item.date === source);
  const segments = [];
  function append(item, start, end, continuation, source = 'schedule') {
    const clippedStart = Math.max(0, start), clippedEnd = Math.min(1440, end);
    if (clippedStart >= clippedEnd) return;
    segments.push({
      id: item.id, source, start: clippedStart, end: clippedEnd, continuation,
      status: source === 'meeting' || item.kind === 'sleep' ? 'unavailable' : item.kind === 'avoid' ? 'avoid' : item.status,
      title: item.title || (item.kind === 'sleep' ? '취침' : item.kind === 'avoid' ? '기피 시간' : '일정'),
    });
  }
  for (const item of data.schedules.filter(item => item.member_id === memberId)) {
    const enabled = source => ['sleep', 'avoid'].includes(item.kind) || item.kind === (hasException(source) ? 'date' : 'weekly');
    const matches = source => item.kind === 'date' ? item.date === source : item.day === weekday(source);
    if (enabled(date) && matches(date)) append(item, item.start_min, item.end_min, false);
    if (item.end_min > 1440 && enabled(previous) && matches(previous)) append(item, item.start_min - 1440, item.end_min - 1440, true);
  }
  for (const meeting of data.meetings || []) {
    if (meeting.status !== 'confirmed' || !meeting.attendees.includes(memberId)) continue;
    const offset = timestamp => (dateValue(timestamp.slice(0, 10)) - dateValue(date)) / 86400000 * 1440 + Number(timestamp.slice(11, 13)) * 60 + Number(timestamp.slice(14, 16));
    const start = offset(meeting.start_at), end = offset(meeting.end_at);
    append(meeting, start, end, start < 0, 'meeting');
  }
  return segments;
}

// Overlapping events share the day's width instead of hiding each other.
export function layoutCalendarEvents(segments) {
  const sorted = segments.map(item => ({ ...item })).sort((a, b) => a.start - b.start || b.end - a.end);
  let group = [], laneEnds = [], groupEnd = -1;
  const finish = () => { for (const item of group) item.lanes = laneEnds.length; };
  for (const item of sorted) {
    if (item.start >= groupEnd) { finish(); group = []; laneEnds = []; }
    let lane = laneEnds.findIndex(end => end <= item.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.end;
    item.lane = lane;
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  finish();
  return sorted;
}

function availabilityBackground(date, getStatus) {
  if (!getStatus) return '';
  const runs = [];
  for (let start = 0; start < 1440; start += 30) {
    if (getStatus(date, start) !== 'available') continue;
    const last = runs.at(-1);
    if (last && last.end === start) last.end += 30;
    else runs.push({ start, end: start + 30 });
  }
  return runs.map(run => `<div class="calendar-available-background" style="top:${run.start / 14.4}%;height:${(run.end - run.start) / 14.4}%" aria-hidden="true"></div>`).join('');
}

export function renderCalendar({ data, memberId, dates, getStatus, single = false, selectionMode = false, selectedScheduleIds = new Set(), selectionBusy = false }) {
  const heads = dates.map(date => `<div class="calendar-heading">${WEEK[weekday(date)]}요일 <span>${date.slice(5).replace('-', '/')}</span></div>`).join('');
  const axis = `<div class="calendar-axis" aria-label="00:00부터 24:00까지 1시간 눈금">${Array.from({ length: 25 }, (_, hour) => `<span class="calendar-hour-label ${hour === 0 ? 'first' : hour === 24 ? 'last' : ''}" style="top:${hour / 24 * 100}%">${String(hour).padStart(2, '0')}:00</span>`).join('')}</div>`;
  const columns = dates.map(date => {
    const targets = Array.from({ length: 24 }, (_, hour) => `<button type="button" class="calendar-hour" data-action="pick-slot" data-date="${date}" data-min="${hour * 60}" data-step="60" ${selectionMode?'disabled':''} aria-label="${date} ${calendarTime(hour * 60)}~${calendarTime((hour + 1) * 60)} 일정 추가"></button>`).join('');
    const events = layoutCalendarEvents(calendarSegments(data, memberId, date)).map(item => {
      const time = `${calendarTime(item.start)}~${calendarTime(item.end)}`;
      const description = `${item.continuation ? '이전 날부터 · ' : ''}${time} · ${LABELS[item.status]}${item.source === 'meeting' ? ' · 확정 회의' : ''}`;
      const selectable=selectionMode&&item.source==='schedule',selected=selectable&&selectedScheduleIds.has(item.id);
      const action=item.source==='meeting'?'calendar-meeting':selectable?'select-schedule':'edit-schedule';
      return `<button type="button" class="calendar-event ${item.status}${item.end - item.start < 60 ? ' short' : ''}${selected?' selected':''}" data-action="${action}" data-id="${escape(item.id)}" ${selectable?`aria-pressed="${selected}"`:''} ${selectionMode&&(selectionBusy||item.source==='meeting')?'disabled':''} style="top:${item.start / 14.4}%;height:${(item.end - item.start) / 14.4}%;left:calc(${item.lane / item.lanes * 100}% + 3px);width:calc(${100 / item.lanes}% - 6px)" aria-label="${escape((selectable?(selected?'선택됨 · ':'선택 · '):'')+item.title + ' · ' + description)}" title="${escape(item.title + ' · ' + description)}"><span class="calendar-event-title">${selectable?(selected?'☑ ':'☐ '):''}${escape(item.title)}</span><span class="calendar-event-status">${LABELS[item.status]}${item.source === 'meeting' ? ' · 회의' : ''}</span><span class="calendar-event-time">${time}${item.continuation ? ' ↳' : ''}</span></button>`;
    }).join('');
    return `<div class="calendar-day-track" data-date="${date}">${availabilityBackground(date, getStatus)}<div class="calendar-hour-targets">${targets}</div><div class="calendar-event-layer">${events}</div></div>`;
  }).join('');
  return `<div class="calendar-scroll ${single ? 'calendar-single' : 'calendar-week'}"><div class="calendar-header"><div class="calendar-heading">시간</div>${heads}</div><div class="calendar-body">${axis}${columns}</div></div>`;
}
