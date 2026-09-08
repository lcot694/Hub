import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toISO, parseISO, occursOn, eventsFor } from "./lib/calendar-domain.js";
import {
  FAMILY_HUB_ONLY, createGoogleSettings, editPermissions, eventWritePlan,
  googleDeleteWarning, syncPresentation, visibleEvents, buildEventSyncIndex, createOperationGuard,
} from "./lib/google-ui.js";

const cfg = window.FAMILY_HUB_CONFIG || {};
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("PASTE_")) {
  document.getElementById("loading").innerHTML =
    `<div class="auth-card"><h2>Setup required</h2><p>Open <strong>README.txt</strong> and complete the Supabase setup, then add your project values to <strong>config.js</strong>.</p></div>`;
  throw new Error("Supabase config missing");
}
const cleanSupabaseUrl = cfg.SUPABASE_URL
  .replace(/\/rest\/v1\/?$/, "")
  .replace(/\/auth\/v1\/?$/, "");

const supabase = createClient(cleanSupabaseUrl, cfg.SUPABASE_PUBLISHABLE_KEY);

const $ = id => document.getElementById(id);
const ui = {
  loading:$("loading"), auth:$("authScreen"), household:$("householdScreen"), app:$("appScreen")
};
let authMode = "signin";
let currentUser = null, household = null, people = [], rawEvents = [], view = "week";
let cursor = new Date();
let realtimeChannel = null;
let editingEventId = null;
let googleStatusByEvent = new Map();
let googleStatusRows = [];
let loadGeneration = 0;
const eventDialogGuard=createOperationGuard();

function showScreen(name){
  Object.values(ui).forEach(x=>x.classList.add("hidden"));
  ui[name].classList.remove("hidden");
}
function msg(el,text,good=false){
  el.textContent=text; el.classList.remove("hidden");
  el.style.background = good ? "#eef8f1" : "#fff2f2";
}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function startOfWeek(d){const x=new Date(d);x.setDate(x.getDate()-x.getDay());x.setHours(0,0,0,0);return x}
function sameDay(a,b){return toISO(a)===toISO(b)}
function fmtDate(d,o={weekday:"long",month:"long",day:"numeric"}){return new Intl.DateTimeFormat("en-CA",o).format(d)}
function fmtTime(t){if(!t)return"";const[h,m]=t.split(":").map(Number);return new Intl.DateTimeFormat("en-CA",{hour:"numeric",minute:"2-digit"}).format(new Date(2000,0,1,h,m))}
function getPerson(id){return people.find(p=>p.id===id)||{name:"Family",color:"#777"}}
async function bootstrap(){
  const {data:{session}}=await supabase.auth.getSession();
  if(!session){showScreen("auth");return}
  currentUser=session.user;
  await loadHousehold();
}
async function loadHousehold(){
  const {data:members,error}=await supabase.from("household_members").select("household_id").eq("user_id",currentUser.id).limit(1);
  if(error){console.error(error);showScreen("household");return}
  if(!members?.length){showScreen("household");return}
  const hid=members[0].household_id;
  const {data:h,error:he}=await supabase.from("households").select("*").eq("id",hid).single();
  if(he){console.error(he);showScreen("household");return}
  household=h;
  await loadData();
  subscribeRealtime();
  showScreen("app");
  render();
  googleSettings.load().catch(() => {});
  googleSettings.requestSync("app_open").catch(() => {});
  if(new URLSearchParams(location.search).get("google")==="connected"){
    googleSettings.load();
    history.replaceState({},"",location.pathname);
  }
}
async function loadData(){
  const generation=++loadGeneration;
  setSync("Syncing…",false);
  const [{data:p,error:pe},{data:e,error:ee}] = await Promise.all([
    supabase.from("people").select("*").eq("household_id",household.id).order("sort_order"),
    supabase.from("events").select("*").eq("household_id",household.id).order("event_date")
  ]);
  if(generation!==loadGeneration)return;
  if(pe||ee){console.error(pe||ee);setSync("Sync error",false);return}
  people=p||[];rawEvents=visibleEvents(e||[]);
  googleStatusByEvent=buildEventSyncIndex(rawEvents,null,new Error("pending"),currentUser.id).byEvent;
  setSync("Connected",true);
  loadGoogleStatuses(generation);
}
async function loadGoogleStatuses(generation){
  let data=null,error=null;
  try{({data,error}=await supabase.rpc("get_google_sync_status",{p_household_id:household.id}))}catch(cause){error=cause}
  if(generation!==loadGeneration)return;
  googleStatusByEvent=buildEventSyncIndex(rawEvents,data,error,currentUser.id).byEvent;
  googleStatusRows=error?[]:(data||[]);
  renderPendingGoogleDeletions();
  if(error){console.warn("Google sync status unavailable");setSync("Calendar available · Google status unavailable",false)}
  render();
}
function renderPendingGoogleDeletions(){
  const root=$("googlePendingDeletions");if(!root)return;root.replaceChildren();
  const rows=googleStatusRows.filter(row=>row.pending_deletion&&row.mapping_owned);
  if(!rows.length)return;
  const heading=document.createElement("strong");heading.textContent="Pending Google deletions";root.append(heading);
  for(const row of rows){
    const item=document.createElement("div");item.className="google-calendar-row";
    const text=document.createElement("span");text.textContent=row.sync_state==="needs_attention"
      ? `Deletion needs attention${row.sync_error?`: ${row.sync_error}`:""}`:"Deletion pending";item.append(text);
    if(row.sync_state==="needs_attention"){
      const retry=document.createElement("button");retry.type="button";retry.className="btn";retry.textContent="Retry deletion";
      retry.onclick=async()=>{retry.disabled=true;try{await supabase.rpc("retry_google_event_sync",{p_family_event_id:row.family_event_id});await googleSettings.requestSync("manual");}finally{retry.disabled=false}};
      item.append(retry);
    }
    root.append(item);
  }
}
function subscribeRealtime(){
  if(realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel=supabase.channel(`household-${household.id}`)
    .on("postgres_changes",{event:"*",schema:"public",table:"events",filter:`household_id=eq.${household.id}`}, async()=>{await loadData();render()})
    .on("postgres_changes",{event:"*",schema:"public",table:"people",filter:`household_id=eq.${household.id}`}, async()=>{await loadData();render()})
    .on("postgres_changes",{event:"*",schema:"public",table:"google_event_sync_status",filter:`household_id=eq.${household.id}`}, async()=>{await loadData();render()})
    .subscribe();
}
function setSync(text,ok=true){if(!$("syncText"))return;$("syncText").textContent=text;$("syncDot").style.background=ok?"#4f9d69":"#c6923c"}

document.querySelectorAll("[data-auth-tab]").forEach(b=>b.onclick=()=>{
  authMode=b.dataset.authTab;
  document.querySelectorAll("[data-auth-tab]").forEach(x=>x.classList.toggle("active",x===b));
  $("authSubmit").textContent=authMode==="signin"?"Sign in":"Create account";
  $("authMessage").classList.add("hidden");
});
$("authForm").onsubmit=async e=>{
  e.preventDefault(); $("authSubmit").disabled=true;
  const email=$("authEmail").value.trim(),password=$("authPassword").value;
  let result;
  if(authMode==="signin") result=await supabase.auth.signInWithPassword({email,password});
  else result=await supabase.auth.signUp({email,password});
  $("authSubmit").disabled=false;
  if(result.error){msg($("authMessage"),result.error.message);return}
  if(authMode==="signup" && !result.data.session){msg($("authMessage"),"Account created. Check your email to confirm it, then sign in.",true);return}
  currentUser=result.data.user; await loadHousehold();
};
$("createHouseholdForm").onsubmit=async e=>{
  e.preventDefault();
  const {data,error}=await supabase.rpc("create_household",{household_name:$("householdName").value.trim()});
  if(error){msg($("householdMessage"),error.message);return}
  await loadHousehold();
};
$("joinHouseholdForm").onsubmit=async e=>{
  e.preventDefault();
  const {data,error}=await supabase.rpc("join_household",{code:$("joinCode").value.trim().toUpperCase()});
  if(error){msg($("householdMessage"),error.message);return}
  await loadHousehold();
};
$("householdSignout").onclick=()=>supabase.auth.signOut().then(()=>location.reload());
$("signoutBtn").onclick=()=>supabase.auth.signOut().then(()=>location.reload());
const googleSettings=createGoogleSettings({
  supabase,
  root:$("googleSettings"),
  disconnectDialog:$("googleDisconnectDialog"),
  getContext:()=>({householdId:household?.id,people}),
  onChanged:()=>{fillEventCalendars($("eventCalendar").value||FAMILY_HUB_ONLY)}
});

function fillEventCalendars(selected=FAMILY_HUB_ONLY,fallbackLabel="Google Calendar"){
  const select=$("eventCalendar");
  select.replaceChildren();
  for(const option of googleSettings.calendarDestinationOptions()){
    const node=document.createElement("option");node.value=option.value;node.textContent=option.label;select.append(node);
  }
  if(selected!==FAMILY_HUB_ONLY&&![...select.options].some(option=>option.value===selected)){
    const node=document.createElement("option");node.value=selected;node.textContent=fallbackLabel;select.append(node);
  }
  if([...select.options].some(option=>option.value===selected))select.value=selected;
}

function fillPersonSelects(){
  ["quickPerson","eventPerson"].forEach(id=>{
    const s=$(id),v=s.value;s.innerHTML="";
    people.forEach(p=>{const o=document.createElement("option");o.value=p.id;o.textContent=p.name;s.appendChild(o)});
    if([...s.options].some(o=>o.value===v))s.value=v;
  });
}
function renderLegend(){
  const el=$("legend");el.innerHTML="";
  people.forEach(p=>{const c=document.createElement("span");c.className="person-chip";c.innerHTML=`<span class="dot" style="background:${p.color}"></span>`;c.append(document.createTextNode(p.name));el.appendChild(c)});
}
function eventCard(e){
  const p=getPerson(e.person_id),el=document.createElement("div");

  el.className="event";
  el.style.setProperty("--event-color",p.color);
  el.style.cursor="pointer";
  el.title="Click to edit";

  el.innerHTML=`
    <div class="event-time">
      ${e.all_day ? "All day" : fmtTime(e.start_time)}
      ${e.end_time ? " – "+fmtTime(e.end_time) : ""}
      ${e.recurrence!=="none" ? " ↻" : ""}
    </div>
    <div class="event-title"></div>
    <div class="event-person"></div>
  `;

  el.querySelector(".event-title").textContent=e.title;
  el.querySelector(".event-person").textContent=p.name;
  appendSyncStatus(el,googleStatusByEvent.get(e.id));

  el.onclick=ev=>{
    ev.stopPropagation();
    openEdit(e);
  };

  return el;
}

function appendSyncStatus(container,mapping,{dialog=false}={}){
  const presentation=syncPresentation(mapping);if(!presentation)return;
  const status=document.createElement("div");
  status.className=dialog?"event-sync-dialog":`event-sync ${mapping.sync_state.replaceAll("_","-")}`;
  status.setAttribute("role","status");
  const label=document.createElement("span");label.textContent=presentation.label;status.append(label);
  if(mapping.calendar_name){const calendar=document.createElement("span");calendar.textContent=` · ${mapping.calendar_name}`;status.append(calendar)}
  if(presentation.retryable&&mapping.sync_error){const error=document.createElement("span");error.textContent=` · ${mapping.sync_error}`;status.append(error)}
  if(presentation.retryable){const retry=document.createElement("button");retry.type="button";retry.className="btn";retry.textContent="Retry";retry.setAttribute("aria-label","Retry Google Calendar sync");retry.onclick=async ev=>{ev?.stopPropagation();retry.disabled=true;try{await googleSettings.requestSync("manual")}finally{retry.disabled=false}};status.append(retry)}
  container.append(status);
}

function renderWeek(){
  const start=startOfWeek(cursor),end=addDays(start,6);
  $("rangeLabel").textContent=`${new Intl.DateTimeFormat("en-CA",{month:"short",day:"numeric"}).format(start)} – ${new Intl.DateTimeFormat("en-CA",{month:"short",day:"numeric",year:"numeric"}).format(end)}`;
  const wrap=document.createElement("div");wrap.className="week";
  for(let i=0;i<7;i++){const d=addDays(start,i),col=document.createElement("div");col.className="daycol"+(sameDay(d,new Date())?" today":"");
    col.innerHTML=`<div class="dayhead"><span class="dow">${new Intl.DateTimeFormat("en-CA",{weekday:"short"}).format(d)}</span><span class="dom">${d.getDate()}</span></div><div class="events"></div>`;
    const holder=col.querySelector(".events"),es=eventsFor(rawEvents,d);if(!es.length)holder.innerHTML='<div class="empty">No events</div>';es.forEach(x=>holder.appendChild(eventCard(x)));col.ondblclick=()=>openAdd(d);wrap.appendChild(col)}
  $("calendar").replaceChildren(wrap);
}
function renderDay(){
  $("rangeLabel").textContent=fmtDate(cursor);const wrap=document.createElement("div");wrap.className="day-view";
  people.forEach(p=>{const col=document.createElement("div");col.className="person-column";col.innerHTML=`<h3><span class="dot" style="background:${p.color}"></span>${p.name}</h3>`;
    const es=eventsFor(rawEvents,cursor).filter(e=>e.person_id===p.id);if(!es.length)col.insertAdjacentHTML("beforeend",'<div class="empty">Nothing scheduled</div>');es.forEach(e=>col.appendChild(eventCard(e)));wrap.appendChild(col)});
  $("calendar").replaceChildren(wrap);
}
function renderMonth(){
  const y=cursor.getFullYear(),m=cursor.getMonth(),start=startOfWeek(new Date(y,m,1));$("rangeLabel").textContent=new Intl.DateTimeFormat("en-CA",{month:"long",year:"numeric"}).format(cursor);
  const wrap=document.createElement("div");wrap.className="month";["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(x=>{const h=document.createElement("div");h.className="month-head";h.textContent=x;wrap.appendChild(h)});
  for(let i=0;i<42;i++){const d=addDays(start,i),cell=document.createElement("div");cell.className="month-day"+(d.getMonth()!==m?" outside":"")+(sameDay(d,new Date())?" today":"");cell.innerHTML=`<div class="month-num">${d.getDate()}</div>`;
    const es=eventsFor(rawEvents,d);es.slice(0,3).forEach(e=>{const p=getPerson(e.person_id),x=document.createElement("div");x.className="month-event";x.style.setProperty("--event-color",p.color);x.textContent=`${e.all_day?"All day":fmtTime(e.start_time)} ${e.title}`;
x.style.cursor="pointer";
x.title="Click to edit";

x.onclick=ev=>{
  ev.stopPropagation();
  openEdit(e);
};

cell.appendChild(x)});if(es.length>3)cell.insertAdjacentHTML("beforeend",`<div class="empty">+${es.length-3} more</div>`);cell.onclick=()=>{cursor=d;view="day";render()};wrap.appendChild(cell)}
  $("calendar").replaceChildren(wrap);
}
function renderToday(){
  const el=$("todayList");el.innerHTML="";const es=eventsFor(rawEvents,new Date());if(!es.length){el.innerHTML='<div class="empty">Nothing scheduled today.</div>';return}
  es.forEach(e=>{const p=getPerson(e.person_id),row=document.createElement("div");row.className="today-row";row.innerHTML=`<div class="today-time">${e.all_day?"All day":fmtTime(e.start_time)}</div><div><div class="today-name"></div><div class="event-person"><span class="dot" style="background:${p.color};margin-right:5px"></span>${p.name}</div></div>`;row.querySelector(".today-name").textContent=e.title;
row.style.cursor="pointer";
row.title="Click to edit";
row.onclick=()=>openEdit(e);
el.appendChild(row)})
}
function renderPeople(){
  const box=$("peopleSettings");box.innerHTML="";
  people.forEach(p=>{const row=document.createElement("div");row.className="person-setting";row.innerHTML=`<strong><span class="dot" style="background:${p.color}"></span></strong><button class="remove-person">Remove</button>`;row.querySelector("strong").append(document.createTextNode(p.name));
    row.querySelector("button").onclick=async()=>{if(confirm(`Remove ${p.name}? Their existing events will remain under Family.`))await supabase.from("people").delete().eq("id",p.id)};box.appendChild(row)})
}
function render(){
  $("householdLabel").textContent=household?.name||"Family Hub";$("todayDate").textContent=fmtDate(new Date());renderLegend();fillPersonSelects();renderToday();
  document.querySelectorAll(".view-switch button").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  if(view==="day")renderDay();else if(view==="month")renderMonth();else renderWeek();
}
function ensureEditButton(){
  const actions=$("eventDialog").querySelector(".modal-actions");

  if(!$("deleteEventBtn")){
    const btn=document.createElement("button");
    btn.id="deleteEventBtn";
    btn.type="button";
    btn.className="btn danger";
    btn.textContent="Delete event";

    btn.onclick=async()=>{
      if(!editingEventId)return;
      const current=rawEvents.find(e=>e.id===editingEventId);

      const mapping=googleStatusByEvent.get(editingEventId);
      const permissions=editPermissions(mapping);
      if(mapping&&!permissions.deleteEverywhere)return;

      const recurring=current?.recurrence!=="none"
        ? " This will delete the entire repeating series."
        : "";

      const warning=mapping
        ? googleDeleteWarning({title:current?.title||"event",calendarName:mapping.calendar_name||"Google Calendar"})
        : `Delete "${current?.title}"?${recurring}`;
      if(!confirm(warning))return;

      setSync("Deleting…",false);
      const eventId=editingEventId,operation=eventDialogGuard.begin(btn);
      let error,operationCurrent=false;
      try{
        ({error}=mapping
          ? await supabase.rpc("request_google_event_delete",{p_family_event_id:eventId})
          : await supabase.from("events").delete().eq("id",eventId));
      }finally{operationCurrent=eventDialogGuard.finish(operation)}

      if(error){
        if(!operationCurrent)return;
        alert(error.message);
        setSync("Delete error",false);
        return;
      }

      if(operationCurrent&&editingEventId===eventId){editingEventId=null;$("eventDialog").close();eventDialogGuard.invalidate()}
    };

    actions.prepend(btn);
  }
}

function setEventDialogMode(mode){
  ensureEditButton();

  const heading=$("eventDialog").querySelector("h2");
  const saveButton=$("eventForm").querySelector('button[type="submit"]');
  const deleteButton=$("deleteEventBtn");

  if(mode==="edit"){
    heading.textContent="Edit event";
    saveButton.textContent="Save changes";
    deleteButton.classList.remove("hidden");
  }else{
    heading.textContent="Add family event";
    saveButton.textContent="Save event";
    deleteButton.classList.add("hidden");
  }
}

function setAllDayControls(){
  const allDay=$("eventAllDay").checked;
  $("eventTimeWrap").classList.toggle("hidden",allDay);$("eventEndTimeWrap").classList.toggle("hidden",allDay);
  $("eventTime").required=!allDay;
}

function setGoogleFieldPermissions(mapping){
  const permissions=editPermissions(mapping);
  $("eventTitle").disabled=!permissions.title;
  ["eventCalendar","eventAllDay","eventDate"].forEach(id=>{$(id).disabled=!permissions.date});
  ["eventTime","eventEndTime"].forEach(id=>{$(id).disabled=!permissions.times});
  ["eventRepeat","eventRepeatEnd"].forEach(id=>{$(id).disabled=!permissions.recurrence});
  $("eventPerson").disabled=!permissions.person;
  $("deleteEventBtn").disabled=!permissions.deleteEverywhere;
  $("deleteEventBtn").title=permissions.deleteEverywhere?"":"Read-only Google events cannot be deleted from Family Hub";
}

function renderDialogSyncStatus(mapping){
  const holder=$("eventSyncStatus");holder.replaceChildren();holder.classList.add("hidden");
  if(mapping){holder.classList.remove("hidden");appendSyncStatus(holder,mapping,{dialog:true})}
}

function openAdd(d=new Date()){
  eventDialogGuard.invalidate();
  editingEventId=null;
  setEventDialogMode("add");

  $("eventTitle").value="";
  $("eventDate").value=toISO(d);
  $("eventTime").value="17:00";
  $("eventEndTime").value="";
  $("eventAllDay").checked=false;
  $("eventRepeat").value="none";
  $("eventRepeatEnd").value="";
  $("repeatEndWrap").classList.add("hidden");
  fillEventCalendars();setGoogleFieldPermissions(null);renderDialogSyncStatus(null);setAllDayControls();

  if(people.length){
    $("eventPerson").value=people[0].id;
  }

  $("eventDialog").showModal();
}

function openEdit(e){
  eventDialogGuard.invalidate();
  editingEventId=e.id;
  setEventDialogMode("edit");

  $("eventTitle").value=e.title || "";
  $("eventPerson").value=e.person_id || "";
  $("eventDate").value=e.event_date;
  $("eventTime").value=(e.start_time || "").slice(0,5);
  $("eventEndTime").value=(e.end_time || "").slice(0,5);
  $("eventAllDay").checked=Boolean(e.all_day);
  $("eventRepeat").value=e.recurrence || "none";
  $("eventRepeatEnd").value=e.recurrence_end || "";

  $("repeatEndWrap").classList.toggle(
    "hidden",
    (e.recurrence || "none")==="none"
  );
  const mapping=googleStatusByEvent.get(e.id);
  fillEventCalendars(mapping?.google_calendar_id||FAMILY_HUB_ONLY,mapping?.calendar_name);
  setGoogleFieldPermissions(mapping);if(mapping)$("eventCalendar").disabled=true;
  renderDialogSyncStatus(mapping);setAllDayControls();

  $("eventDialog").showModal();
}
document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>{if(b.dataset.close==="eventDialog")eventDialogGuard.invalidate();$(b.dataset.close).close()});
document.querySelectorAll(".view-switch button").forEach(b=>b.onclick=()=>{view=b.dataset.view;render()});
$("todayBtn").onclick=()=>{cursor=new Date();render()};
$("prevBtn").onclick=()=>{cursor=view==="month"?new Date(cursor.getFullYear(),cursor.getMonth()-1,1):addDays(cursor,view==="week"?-7:-1);render()};
$("nextBtn").onclick=()=>{cursor=view==="month"?new Date(cursor.getFullYear(),cursor.getMonth()+1,1):addDays(cursor,view==="week"?7:1);render()};
$("addBtn").onclick=()=>openAdd(cursor);
$("familyBtn").onclick=()=>{renderPeople();googleSettings.load();$("familyDialog").showModal()};
$("shareBtn").onclick=()=>{$("shareCode").textContent=household.join_code;$("shareDialog").showModal()};
$("copyCodeBtn").onclick=async()=>{await navigator.clipboard.writeText(household.join_code);$("copyCodeBtn").textContent="Copied!";setTimeout(()=>$("copyCodeBtn").textContent="Copy code",1200)};
$("eventRepeat").onchange=()=>{$("repeatEndWrap").classList.toggle("hidden",$("eventRepeat").value==="none")};
$("eventAllDay").onchange=setAllDayControls;
$("eventForm").onsubmit=async e=>{
  e.preventDefault();
  const saveButton=$("eventForm").querySelector('button[type="submit"]');
  const eventId=editingEventId;
  const mapping=eventId?googleStatusByEvent.get(eventId):null;
  setSync(editingEventId ? "Updating…" : "Saving…",false);

  if(mapping&&!editPermissions(mapping).title){
    const operation=eventDialogGuard.begin(saveButton);
    let result,operationCurrent=false;try{result=await supabase.from("events").update({person_id:$("eventPerson").value||null}).eq("id",eventId)}finally{operationCurrent=eventDialogGuard.finish(operation)}
    if(!operationCurrent)return;
    if(result.error){alert(result.error.message);setSync("Update error",false);return}
    if(editingEventId===eventId){editingEventId=null;$("eventDialog").close();eventDialogGuard.invalidate()}
    return;
  }

  const payload={
    household_id:household.id,
    ...(eventId?{id:eventId}:{}),
    person_id:$("eventPerson").value||null,
    title:$("eventTitle").value.trim(),
    event_date:$("eventDate").value,
    start_time:$("eventAllDay").checked?null:($("eventTime").value||null),
    end_time:$("eventAllDay").checked?null:($("eventEndTime").value||null),
    all_day:$("eventAllDay").checked,
    recurrence:$("eventRepeat").value,
    recurrence_end:
      $("eventRepeat").value==="none"
        ? null
        : ($("eventRepeatEnd").value||null)
  };

  const plan=eventWritePlan(payload,$("eventCalendar").value,eventId!==null);
  if(plan.kind==="blocked"){alert(plan.notice);setSync("Calendar available",true);return}
  const operation=eventDialogGuard.begin(saveButton);
  let result,operationCurrent=false;
  try{
    if(plan.kind==="google-rpc")result=await supabase.rpc(plan.functionName,plan.args);
    else if(plan.kind==="family-update"){
      const {id:_eventId,...familyPayload}=plan.payload;
      result=await supabase.from("events").update(familyPayload).eq("id",eventId);
    }
    else result=await supabase.from("events").insert({...plan.payload,created_by:currentUser.id});
  }finally{operationCurrent=eventDialogGuard.finish(operation)}
  if(!operationCurrent)return;

  if(result.error){
    alert(result.error.message);
    setSync(editingEventId ? "Update error" : "Save error",false);
    return;
  }
  if(plan.notice)alert(plan.notice);

  if(editingEventId===eventId){editingEventId=null;$("eventDialog").close();eventDialogGuard.invalidate()}
};
$("quickForm").onsubmit=async e=>{
  e.preventDefault();const {error}=await supabase.from("events").insert({household_id:household.id,person_id:$("quickPerson").value||null,title:$("quickTitle").value.trim(),event_date:$("quickDate").value,start_time:$("quickTime").value||null,recurrence:"none",created_by:currentUser.id});
  if(error)alert(error.message);else $("quickTitle").value=""
};
$("addPersonBtn").onclick=()=>{$("personName").value="";$("personDialog").showModal()};
$("personForm").onsubmit=async e=>{
  e.preventDefault();const next=(people.at(-1)?.sort_order||0)+1;const {error}=await supabase.from("people").insert({household_id:household.id,name:$("personName").value.trim(),color:$("personColor").value,sort_order:next});if(error)alert(error.message);else $("personDialog").close()
};

$("quickDate").value=toISO(new Date());$("quickTime").value="17:00";
supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    currentUser = null;
    household = null;
    people = [];
    rawEvents = [];
    showScreen("auth");
    return;
  }

  currentUser = session.user;
});
if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.warn);
bootstrap();
