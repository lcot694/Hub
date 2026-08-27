export function toISO(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toLocaleDateString("en-CA");
}

export function parseISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function monthlyAnniversary(start, target) {
  const day = Math.min(start.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(target.getFullYear(), target.getMonth(), day);
}

function yearlyAnniversary(start, target) {
  const day = Math.min(start.getDate(), daysInMonth(target.getFullYear(), start.getMonth()));
  return new Date(target.getFullYear(), start.getMonth(), day);
}

export function occursOn(event, date) {
  const target = toISO(date);
  if (event.recurrence === "none") return event.event_date === target;
  if (target < event.event_date || (event.recurrence_end && target > event.recurrence_end)) return false;
  const diff = Math.round((date - parseISO(event.event_date)) / 86400000);
  if (event.recurrence === "daily") return diff >= 0;
  if (event.recurrence === "weekly") return diff >= 0 && diff % 7 === 0;
  const start = parseISO(event.event_date);
  if (event.recurrence === "monthly") {
    return toISO(monthlyAnniversary(start, date)) === target;
  }
  if (event.recurrence === "yearly") {
    return toISO(yearlyAnniversary(start, date)) === target;
  }
  return false;
}

export function normalizeEventTimes(input) {
  return input.all_day
    ? { all_day:true, start_time:null, end_time:null }
    : { all_day:false, start_time:input.start_time || null, end_time:input.end_time || null };
}

export function eventsFor(events, date) {
  return events.filter(event => occursOn(event, date))
    .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
}
