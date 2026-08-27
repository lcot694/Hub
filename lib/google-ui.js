const FAMILY_HUB_ONLY = "family-hub-only";

export function calendarDestinationOptions(calendars, connectionState = "active") {
  return [
    { value: FAMILY_HUB_ONLY, label: "Family Hub only" },
    ...(connectionState === "active" ? calendars : [])
      .filter((calendar) => calendar.enabled && calendar.writable)
      .map((calendar) => ({ value: calendar.googleCalendarId || calendar.id, label: calendar.summary })),
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
}) {
  const connectButton = element(root, "googleConnectBtn");
  const personSelect = element(root, "googlePerson");
  const calendarList = element(root, "googleCalendarList");
  const syncNowButton = element(root, "googleSyncNowBtn");
  const disconnectButton = element(root, "googleDisconnectBtn");
  let model = { connection: null, calendars: [] };
  let modelOperationGeneration = 0;
  let pendingModelOperations = 0;

  const setPending = (pending) => {
    connectButton.disabled = pending;
    personSelect.disabled = pending;
    syncNowButton.disabled = pending;
    disconnectButton.disabled = pending;
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
  syncNowButton.addEventListener("click", () => invoke("google-sync", { method: "POST" }).catch(() => {}));
  disconnectButton.addEventListener("click", () => invoke("google-disconnect", { method: "POST" }).then(load).catch(() => {}));

  return { load, calendarDestinationOptions: () => calendarDestinationOptions(model.calendars, model.connection?.state) };
}
