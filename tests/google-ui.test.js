import test from "node:test";
import assert from "node:assert/strict";
import { calendarDestinationOptions, createGoogleSettings } from "../lib/google-ui.js";

function fakeNode(id = "") {
  const listeners = new Map();
  return {
    id, children: [], value: "", checked: false, type: "", disabled: false, className: "", _text: "",
    classList: { toggle() {} },
    get options() { return this.children.filter((child) => child.tagName === "option"); },
    get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; },
    set textContent(value) { this._text = value; this.children = []; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this._text = ""; this.children = children; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    async fire(name) { return listeners.get(name)?.(); },
    querySelector(selector) {
      const matches = this.querySelectorAll(selector);
      return matches[0] ?? null;
    },
    querySelectorAll(selector) {
      const all = [];
      const visit = (node) => {
        if ((selector.startsWith("#") && node.id === selector.slice(1)) ||
          (selector === 'input[type="checkbox"]' && node.tagName === "input" && node.type === "checkbox")) all.push(node);
        node.children.forEach(visit);
      };
      visit(this);
      return all;
    },
  };
}

function fakeDocument() {
  return {
    createElement(tagName) { const node = fakeNode(); node.tagName = tagName; return node; },
    createTextNode(text) { const node = fakeNode(); node._text = text; node.tagName = "#text"; return node; },
  };
}

function settingsRoot() {
  const root = fakeNode("googleSettings");
  for (const id of ["googleConnectBtn", "googlePerson", "googleCalendarList", "googleSyncNowBtn", "googleDisconnectBtn"]) root.append(fakeNode(id));
  return root;
}

test("read-only calendars cannot become event destinations", () => {
  const options = calendarDestinationOptions([
    { id: "family", summary: "Family", enabled: true, writable: true },
    { id: "holidays", summary: "Holidays", enabled: true, writable: false },
    { id: "disabled", summary: "Disabled", enabled: false, writable: true },
  ]);

  assert.deepEqual(options.map((option) => option.value), ["family-hub-only", "family"]);
});

test("inactive Google connections cannot become event destinations", () => {
  const options = calendarDestinationOptions([
    { id: "family", summary: "Family", enabled: true, writable: true },
  ], "reconnect_required");

  assert.deepEqual(options.map((option) => option.value), ["family-hub-only"]);
});

test("controller renders remote labels as text and ignores a stale load response", async () => {
  const document = fakeDocument();
  const root = settingsRoot();
  const responses = [];
  const supabase = { functions: { invoke: () => new Promise((resolve) => responses.push(resolve)) } };
  const settings = createGoogleSettings({
    supabase, root, document, location: { assign() {} },
    getContext: () => ({ householdId: "household", people: [{ id: "person", name: "Parent" }] }),
  });

  const first = settings.load();
  const second = settings.load();
  responses[1]({ data: { connection: { state: "active", personId: "person", displayEmail: "<img>" }, calendars: [{ googleCalendarId: "new", summary: "<b>New</b>", enabled: true, writable: true }] }, error: null });
  await second;
  responses[0]({ data: { connection: null, calendars: [] }, error: null });
  await first;

  assert.deepEqual(settings.calendarDestinationOptions().map((option) => option.value), ["family-hub-only", "new"]);
  assert.match(root.querySelector("#googleCalendarList").textContent, /<b>New<\/b>/);
  assert.equal(root.querySelector("#googleCalendarList").querySelector("#b"), null);
});

test("controller renders loading, disconnected, and reconnect states", async () => {
  const document = fakeDocument();
  const root = settingsRoot();
  const responses = [];
  const supabase = { functions: { invoke: () => new Promise((resolve) => responses.push(resolve)) } };
  const settings = createGoogleSettings({
    supabase, root, document, location: { assign() {} },
    getContext: () => ({ householdId: "household", people: [{ id: "person", name: "Parent" }] }),
  });

  const disconnected = settings.load();
  assert.match(root.querySelector("#googleCalendarList").textContent, /Loading/);
  responses.shift()({ data: { connection: null, calendars: [] }, error: null });
  await disconnected;
  assert.match(root.querySelector("#googleCalendarList").textContent, /Connect a Google account/);

  const reconnect = settings.load();
  responses.shift()({ data: { connection: { state: "reconnect_required", personId: "person", displayEmail: null }, calendars: [] }, error: null });
  await reconnect;
  assert.match(root.querySelector("#googleCalendarList").textContent, /Reconnect Google Calendar/);
  assert.deepEqual(settings.calendarDestinationOptions().map((option) => option.value), ["family-hub-only"]);
});
