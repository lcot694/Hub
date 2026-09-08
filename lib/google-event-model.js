const SUPPORTED_FREQUENCIES = new Map([
  ["DAILY", "daily"],
  ["WEEKLY", "weekly"],
  ["MONTHLY", "monthly"],
  ["YEARLY", "yearly"]
]);
const DEFAULT_HOUSEHOLD_TIME_ZONE = "America/Toronto";

function formatter(timeZone, withTime) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    ...(withTime ? { hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23" } : {})
  });
}

function formattedParts(value, timeZone, withTime) {
  const parts = formatter(timeZone, withTime).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, part]));
}

function localDateTime(value, timeZone) {
  const parts = formattedParts(value, timeZone, true);
  return { date:`${parts.year}-${parts.month}-${parts.day}`, time:`${parts.hour}:${parts.minute}` };
}

function localDate(value, timeZone) {
  const parts = formattedParts(value, timeZone, false);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function addDateDays(date, days) {
  let [year, month, day] = date.split("-").map(Number);
  for (let remaining = days; remaining > 0; remaining -= 1) {
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function compactDate(date) {
  return date.replaceAll("-", "");
}

function localTimeWithSeconds(time) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time || "");
  if (!match) throw new TypeError("Timed events require an HH:mm start and end time");
  return `${match[1]}:${match[2]}:${match[3] || "00"}`;
}

function zonedTimeToUtc(date, time, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;

  for (let i = 0; i < 4; i += 1) {
    const parts = formattedParts(guess, timeZone, true);
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = target - observed;
    if (correction === 0) break;
    guess += correction;
  }

  return new Date(guess).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function recurrenceFromGoogle(recurrence, timeZone) {
  if (!recurrence?.length) return { supported:true, recurrence:"none", recurrenceEnd:null };
  if (!Array.isArray(recurrence) || recurrence.length !== 1 || !recurrence[0].startsWith("RRULE:")) {
    return { supported:false };
  }

  const fields = new Map();
  for (const entry of recurrence[0].slice("RRULE:".length).split(";")) {
    const [name, value, extra] = entry.split("=");
    if (!name || !value || extra || fields.has(name)) return { supported:false };
    fields.set(name, value);
  }

  const frequency = SUPPORTED_FREQUENCIES.get(fields.get("FREQ"));
  if (!frequency || [...fields.keys()].some(name => !["FREQ", "INTERVAL", "UNTIL"].includes(name))) {
    return { supported:false };
  }
  if (fields.has("INTERVAL") && fields.get("INTERVAL") !== "1") return { supported:false };

  const until = fields.get("UNTIL");
  if (!until) return { supported:true, recurrence:frequency, recurrenceEnd:null };
  if (/^\d{8}$/.test(until)) {
    return { supported:true, recurrence:frequency, recurrenceEnd:`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` };
  }
  if (/^\d{8}T\d{6}Z$/.test(until)) {
    return { supported:true, recurrence:frequency, recurrenceEnd:localDate(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`, timeZone) };
  }
  return { supported:false };
}

function recurrenceForGoogle(familyEvent, timeZone) {
  if (!familyEvent.recurrence || familyEvent.recurrence === "none") return undefined;
  const frequency = familyEvent.recurrence.toUpperCase();
  if (!SUPPORTED_FREQUENCIES.has(frequency)) throw new TypeError("Unsupported Family Hub recurrence");
  if (!recurrenceOccurrencesMatchGoogle(familyEvent.recurrence, familyEvent.event_date)) {
    throw new TypeError("Google RRULE cannot preserve Family Hub recurrence occurrences");
  }

  let rule = `RRULE:FREQ=${frequency}`;
  if (familyEvent.recurrence_end) {
    rule += familyEvent.all_day
      ? `;UNTIL=${compactDate(familyEvent.recurrence_end)}`
      : `;UNTIL=${zonedTimeToUtc(familyEvent.recurrence_end, "23:59:59", timeZone)}`;
  }
  return [rule];
}

function recurrenceOccurrencesMatchGoogle(recurrence, startDate) {
  const [, month, day] = String(startDate || "").split("-").map(Number);
  if (recurrence === "monthly") return day <= 28;
  if (recurrence === "yearly") return month !== 2 || day !== 29;
  return true;
}

export function googleToFamilyEvent(googleEvent, context) {
  if (googleEvent.recurringEventId || googleEvent.originalStartTime) {
    return { supported:false, readOnlyReason:"complex_recurrence_exception" };
  }

  const timeZone = context.householdTimeZone || DEFAULT_HOUSEHOLD_TIME_ZONE;
  const allDay = typeof googleEvent.start?.date === "string";
  const recurrence = recurrenceFromGoogle(googleEvent.recurrence, timeZone);
  if (!recurrence.supported) return { supported:false, readOnlyReason:"complex_recurrence" };
  const sourceTimeZones = [googleEvent.start?.timeZone, googleEvent.end?.timeZone].filter(Boolean);
  if (!allDay && recurrence.recurrence !== "none" && sourceTimeZones.some(sourceTimeZone => sourceTimeZone !== timeZone)) {
    return { supported:false, readOnlyReason:"recurring_time_zone_mismatch" };
  }

  if (allDay) {
    if (googleEvent.end?.date !== addDateDays(googleEvent.start.date, 1)) {
      return { supported:false, readOnlyReason:"multi_day_event" };
    }
    if (!recurrenceOccurrencesMatchGoogle(recurrence.recurrence, googleEvent.start.date)) {
      return { supported:false, readOnlyReason:"recurrence_occurrence_mismatch" };
    }
    return {
      supported:true,
      event:{
        household_id:context.householdId,
        person_id:context.defaultPersonId || null,
        title:googleEvent.summary || "",
        event_date:googleEvent.start.date,
        start_time:null,
        end_time:null,
        all_day:true,
        recurrence:recurrence.recurrence,
        recurrence_end:recurrence.recurrenceEnd
      }
    };
  }

  if (typeof googleEvent.start?.dateTime !== "string") {
    return { supported:false, readOnlyReason:"unsupported_event_time" };
  }

  const start = localDateTime(googleEvent.start.dateTime, timeZone);
  const end = typeof googleEvent.end?.dateTime === "string"
    ? localDateTime(googleEvent.end.dateTime, timeZone)
    : null;
  if (end && end.date !== start.date) return { supported:false, readOnlyReason:"multi_day_event" };
  if (end && end.time < start.time) return { supported:false, readOnlyReason:"ambiguous_local_time" };
  if (!recurrenceOccurrencesMatchGoogle(recurrence.recurrence, start.date)) {
    return { supported:false, readOnlyReason:"recurrence_occurrence_mismatch" };
  }
  return {
    supported:true,
    event:{
      household_id:context.householdId,
      person_id:context.defaultPersonId || null,
      title:googleEvent.summary || "",
      event_date:start.date,
      start_time:start.time,
      end_time:end?.time || null,
      all_day:false,
      recurrence:recurrence.recurrence,
      recurrence_end:recurrence.recurrenceEnd
    }
  };
}

export function familyToGoogleEvent(familyEvent, context) {
  const timeZone = context.householdTimeZone || DEFAULT_HOUSEHOLD_TIME_ZONE;
  const payload = { summary:familyEvent.title || "" };

  if (familyEvent.all_day) {
    payload.start = { date:familyEvent.event_date };
    payload.end = { date:addDateDays(familyEvent.event_date, 1) };
  } else {
    const start = localTimeWithSeconds(familyEvent.start_time);
    const end = localTimeWithSeconds(familyEvent.end_time || familyEvent.start_time);
    if (end < start) throw new TypeError("end time must not be earlier than start time");
    payload.start = { dateTime:`${familyEvent.event_date}T${start}`, timeZone };
    payload.end = { dateTime:`${familyEvent.event_date}T${end}`, timeZone };
  }

  const recurrence = recurrenceForGoogle(familyEvent, timeZone);
  if (recurrence) payload.recurrence = recurrence;
  return payload;
}
