export const FAMILY_HUB_ONLY = "family-hub-only";

export function visibleEvents(events) {
  return events.filter((event) => !event.sync_deleted_at);
}

const SYNC_PRESENTATIONS = {
  synced: { label: "Synced", retryable: false },
  syncing: { label: "Syncing", retryable: false },
  needs_attention: { label: "Needs attention", retryable: true },
  read_only: { label: "Read only", retryable: false },
};

export function syncPresentation(mapping) {
  if (mapping?.uncertain) return { label: "Sync status unavailable", retryable: false };
  return mapping ? (SYNC_PRESENTATIONS[mapping.sync_state] ?? null) : null;
}

export function editPermissions(mapping) {
  if (mapping?.uncertain || mapping?.mapping_owned === false) {
    return { title: false, date: false, times: false, recurrence: false, person: false, deleteEverywhere: false };
  }
  const readOnly = mapping?.sync_state === "read_only" || mapping?.calendar_writable === false || mapping?.writable === false || mapping?.mapping_can_edit === false;
  return { title: !readOnly, date: !readOnly, times: !readOnly, recurrence: !readOnly, person: true, deleteEverywhere: !readOnly };
}

export function buildEventSyncIndex(events, rows, error, currentUserId) {
  if (error) return {
    known: false,
    byEvent: new Map(events.map((event) => [event.id, { sync_state: "unknown", uncertain: true, mapping_owned: false }])),
  };
  const byEvent = new Map((rows ?? []).filter((row) => row.family_event_id).map((row) => {
    const mappingOwned = typeof row.mapping_owned === "boolean" ? row.mapping_owned : row.owner_user_id === currentUserId;
    return [row.family_event_id, { ...row, mapping_owned: mappingOwned }];
  }));
  return { known: true, byEvent };
}

export function createOperationGuard() {
  let generation = 0;
  const buttonTokens = new Map();
  return {
    begin(button) {
      const token = { generation, button, id: Symbol("dialog-operation") };
      buttonTokens.set(button, token);button.disabled = true;return token;
    },
    invalidate() {
      generation += 1;
      for (const button of buttonTokens.keys()) button.disabled = false;
      buttonTokens.clear();
    },
    isCurrent(token) { return token.generation === generation && buttonTokens.get(token.button) === token; },
    finish(token) {
      if (buttonTokens.get(token.button) !== token) return false;
      token.button.disabled = false;buttonTokens.delete(token.button);
      return token.generation === generation;
    },
  };
}

export function googleDeleteWarning({ title, calendarName }) {
  return `Delete "${title}" from Family Hub and Google Calendar “${calendarName}”? This deletes it everywhere.`;
}

export function eventWritePlan(payload, destination, editing) {
  if (destination === FAMILY_HUB_ONLY) return { kind: editing ? "family-update" : "family-insert", payload };
  const [year, month, day] = String(payload.event_date || "").split("-").map(Number);
  const mismatched = (payload.recurrence === "monthly" && day > 28) ||
    (payload.recurrence === "yearly" && month === 2 && day === 29);
  if (mismatched) {
    const notice = "This recurrence stays in Family Hub because Google Calendar would show different dates.";
    return editing ? { kind: "blocked", notice } : { kind: "family-insert", payload, notice };
  }
  return { kind: "google-rpc", functionName: "save_google_backed_event", args: { p_event: { ...payload, google_calendar_id: destination } } };
}

export function calendarDestinationOptions(calendars, connectionState = "active") {
  return [
    { value: FAMILY_HUB_ONLY, label: "Family Hub only" },
    ...(connectionState === "active" ? calendars : [])
      .filter((calendar) => calendar.enabled && calendar.writable)
      .map((calendar) => ({ value: calendar.id || calendar.googleCalendarId, label: calendar.summary })),
  ];
}

function element(root, id) {
  const value = root.querySelector(`#${id}`);
  if (!value) throw new Error(`Google settings is missing #${id}`);
  return value;
}

function clear(node) {
  node.replaceChildren();
}

function addText(documentRef, node, text) {
  node.append(documentRef.createTextNode(text));
}

function setButtonVisibility(button, visible) {
  button.classList.toggle("hidden", !visible);
}

export function createGoogleSettings({
  supabase, root, getContext, onChanged = () => {},
  document: documentRef = globalThis.document,
  location: locationRef = globalThis.window?.location,
  disconnectDialog: providedDisconnectDialog,
}) {
  const connectButton = element(root, "googleConnectBtn");
  const personSelect = element(root, "googlePerson");
  const calendarList = element(root, "googleCalendarList");
  const syncNowButton = element(root, "googleSyncNowBtn");
  const disconnectButton = element(root, "googleDisconnectBtn");
  const disconnectDialog = providedDisconnectDialog ?? element(root, "googleDisconnectDialog");
  const keepLocalButton = element(disconnectDialog, "googleKeepLocalBtn");
  const removeLocalButton = element(disconnectDialog, "googleRemoveLocalBtn");
  const disconnectCancelButton = element(disconnectDialog, "googleDisconnectCancelBtn");
  const disconnectError = element(disconnectDialog, "googleDisconnectError");
  let model = { connection: null, calendars: [] };
  let modelOperationGeneration = 0;
  let pendingModelOperations = 0;
  let disconnectInFlight = false;

  const setPending = (pending) => {
    connectButton.disabled = pending;
    personSelect.disabled = pending;
    syncNowButton.disabled = pending;
    disconnectButton.disabled = pending;
    keepLocalButton.disabled = pending;
    removeLocalButton.disabled = pending;
    disconnectCancelButton.disabled = pending;
    calendarList.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = pending; });
  };

  const beginModelOperation = () => {
    modelOperationGeneration += 1;
    pendingModelOperations += 1;
    setPending(true);
    return modelOperationGeneration;
  };

  const finishModelOperation = () => {
    pendingModelOperations -= 1;
    if (pendingModelOperations === 0) setPending(false);
  };

  const renderPeople = (personId) => {
    const { people = [] } = getContext();
    clear(personSelect);
    for (const person of people) {
      const option = documentRef.createElement("option");
      option.value = person.id;
      option.textContent = person.name;
      personSelect.append(option);
    }
    if (personId && [...personSelect.options].some((option) => option.value === personId)) {
      personSelect.value = personId;
    }
  };

  const renderCalendars = () => {
    for (const calendar of model.calendars) {
      const row = documentRef.createElement("label");
      row.className = "google-calendar-row";
      const checkbox = documentRef.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = calendar.enabled;
      checkbox.disabled = pendingModelOperations > 0;
      checkbox.addEventListener("change", () => saveCalendars());
      const details = documentRef.createElement("span");
      details.className = "google-calendar-details";
      const name = documentRef.createElement("strong");
      name.textContent = calendar.summary;
      const permission = documentRef.createElement("small");
      permission.textContent = calendar.writable ? "Can edit" : "Read only";
      details.append(name, permission);
      row.append(checkbox, details);
      calendarList.append(row);
    }
  };

  const render = () => {
    const connection = model.connection;
    renderPeople(connection?.personId);
    clear(calendarList);
    if (!connection) {
      addText(documentRef, calendarList, "Connect a Google account to choose calendars.");
      connectButton.textContent = "Connect Google Calendar";
      setButtonVisibility(connectButton, true);
      setButtonVisibility(syncNowButton, false);
      setButtonVisibility(disconnectButton, false);
      return;
    }
    if (connection.state === "reconnect_required") {
      addText(documentRef, calendarList, "Reconnect Google Calendar to continue syncing.");
      connectButton.textContent = "Reconnect Google Calendar";
      setButtonVisibility(connectButton, true);
      setButtonVisibility(syncNowButton, false);
      setButtonVisibility(disconnectButton, true);
      return;
    }
    if (connection.state === "disconnected") {
      addText(documentRef, calendarList, "This Google account is disconnected.");
      connectButton.textContent = "Connect Google Calendar";
      setButtonVisibility(connectButton, true);
      setButtonVisibility(syncNowButton, false);
      setButtonVisibility(disconnectButton, false);
      return;
    }
    if (connection.displayEmail) {
      const account = documentRef.createElement("p");
      account.className = "google-account";
      account.textContent = connection.displayEmail;
      calendarList.append(account);
    }
    renderCalendars();
    setButtonVisibility(connectButton, false);
    setButtonVisibility(syncNowButton, true);
    setButtonVisibility(disconnectButton, true);
  };

  const invoke = async (name, options) => {
    const { data, error } = await supabase.functions.invoke(name, options);
    if (error) throw error;
    return data;
  };

  const load = async () => {
    const request = beginModelOperation();
    clear(calendarList);
    addText(documentRef, calendarList, "Loading Google Calendar settings…");
    try {
      const nextModel = await invoke("google-calendars", { method: "GET" });
      if (request !== modelOperationGeneration) return;
      model = nextModel;
      render();
      onChanged(model);
    } catch {
      if (request !== modelOperationGeneration) return;
      clear(calendarList);
      addText(documentRef, calendarList, "Google Calendar settings could not be loaded.");
    } finally {
      finishModelOperation();
    }
  };

  const saveCalendars = async () => {
    if (!model.connection) return;
    const request = beginModelOperation();
    const calendars = model.calendars.map((calendar, index) => ({
      googleCalendarId: calendar.googleCalendarId,
      enabled: calendarList.querySelectorAll('input[type="checkbox"]')[index].checked,
    }));
    try {
      const nextModel = await invoke("google-calendars", {
        method: "PUT",
        body: { personId: personSelect.value, calendars },
      });
      if (request !== modelOperationGeneration) return;
      model = nextModel;
      render();
      onChanged(model);
    } catch {
      if (request !== modelOperationGeneration) return;
      render();
    } finally {
      finishModelOperation();
    }
  };

  connectButton.addEventListener("click", async () => {
    const { householdId } = getContext();
    if (!householdId || !personSelect.value) return;
    try {
      const data = await invoke("google-oauth-start", {
        method: "POST",
        body: { householdId, personId: personSelect.value },
      });
      if (typeof data?.authorizationUrl === "string") locationRef.assign(data.authorizationUrl);
    } catch {
      clear(calendarList);
      addText(documentRef, calendarList, "Google Calendar could not be connected.");
    }
  });
  personSelect.addEventListener("change", () => saveCalendars());
  const requestSync = (reason) => invoke("google-sync", { method: "POST", body: { reason } });
  syncNowButton.addEventListener("click", () => requestSync("manual").catch(() => {}));
  disconnectButton.addEventListener("click", () => {
    disconnectError.textContent = "";
    disconnectDialog.showModal();
  });
  disconnectCancelButton.addEventListener("click", () => disconnectDialog.close());
  const disconnect = async (mode) => {
    if (disconnectInFlight) return;
    disconnectInFlight = true;
    const request = beginModelOperation();
    disconnectError.textContent = "";
    try {
      await invoke("google-disconnect", { method: "POST", body: { mode } });
      if (request !== modelOperationGeneration) return;
      disconnectDialog.close();
      await load();
    } catch {
      if (request !== modelOperationGeneration) return;
      disconnectError.textContent = "Google Calendar could not be disconnected. Please try again.";
    } finally {
      disconnectInFlight = false;
      finishModelOperation();
    }
  };
  keepLocalButton.addEventListener("click", () => disconnect("keep_local"));
  removeLocalButton.addEventListener("click", () => disconnect("remove_local"));

  return { load, requestSync, calendarDestinationOptions: () => calendarDestinationOptions(model.calendars, model.connection?.state) };
}
