function timestampNanos(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value || "");
  if (!match) return null;
  const milliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(milliseconds)) return null;
  const fraction = BigInt((match[2] || "").padEnd(9, "0").slice(0, 9));
  return BigInt(milliseconds) * 1000000n + fraction;
}

function timestampChanged(current, observed) {
  if (!current) return false;
  if (!observed) return true;
  const currentTime = timestampNanos(current);
  const observedTime = timestampNanos(observed);
  if (currentTime === null || observedTime === null) return current !== observed;
  return currentTime !== observedTime;
}

function compareTimestamps(familyTimestamp, googleTimestamp) {
  const familyTime = timestampNanos(familyTimestamp);
  const googleTime = timestampNanos(googleTimestamp);
  if (familyTime === null || googleTime === null) return "google";
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
  return Math.floor(Math.random() * baseDelay);
}

/**
 * `options.jitter(baseDelay, attempt)` is an optional deterministic fourth
 * argument for tests; production calls use Math.random-derived jitter.
 */
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
