function timestampChanged(current, observed) {
  if (!current) return false;
  if (!observed) return true;
  const currentTime = Date.parse(current);
  const observedTime = Date.parse(observed);
  if (Number.isNaN(currentTime) || Number.isNaN(observedTime)) return current !== observed;
  return currentTime !== observedTime;
}

function compareTimestamps(familyTimestamp, googleTimestamp) {
  const familyTime = Date.parse(familyTimestamp);
  const googleTime = Date.parse(googleTimestamp);
  if (Number.isNaN(familyTime) || Number.isNaN(googleTime)) return "google";
  return familyTime > googleTime ? "family" : "google";
}

export function chooseConflictWinner(mapping, familyEvent, googleEvent) {
  const familyChanged = timestampChanged(familyEvent.updated_at, mapping.last_family_updated_at);
  const googleChanged = timestampChanged(googleEvent.updated, mapping.last_google_updated_at);

  if (!familyChanged && !googleChanged) return "unchanged";
  if (familyChanged && !googleChanged) return "family";
  if (!familyChanged && googleChanged) return "google";
  return compareTimestamps(familyEvent.updated_at, googleEvent.updated);
}

function jitterSeconds(options, baseDelay, attempt) {
  if (typeof options === "function") return Number(options(baseDelay, attempt)) || 0;
  if (typeof options?.jitter === "function") return Number(options.jitter(baseDelay, attempt)) || 0;
  return 0;
}

export function retryDecision(errorCategory, attempt, now, options) {
  if (!new Set(["transient", "rate_limit"]).has(errorCategory)) {
    return { retryable:false, nextAttemptAt:null };
  }

  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.valueOf())) throw new TypeError("now must be a valid timestamp");
  const normalizedAttempt = Math.max(0, Number(attempt) || 0);
  const baseDelay = Math.min(3600, 2 ** normalizedAttempt * 30);
  const delay = Math.max(0, baseDelay + jitterSeconds(options, baseDelay, normalizedAttempt));
  return { retryable:true, nextAttemptAt:new Date(timestamp.valueOf() + delay * 1000).toISOString() };
}
