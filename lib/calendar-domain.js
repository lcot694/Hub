export function toISO(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toLocaleDateString("en-CA");
}

export function parseISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function occursOn(event, date) {
  const target = toISO(date);
  if (event.recurrence === "none") return event.event_date === target;
  if (target < event.event_date || (event.recurrence_end && target > event.recurrence_end)) return false;
  const diff = Math.round((date - parseISO(event.event_date)) / 86400000);
  if (event.recurrence === "daily") return diff >= 0;
  if (event.recurrence === "weekly") return diff >= 0 && diff % 7 === 0;
  return false;
}

export function eventsFor(events, date) {
  return events.filter(event => occursOn(event, date))
    .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
}
