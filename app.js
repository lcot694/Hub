import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function showScreen(name){
  Object.values(ui).forEach(x=>x.classList.add("hidden"));
  ui[name].classList.remove("hidden");
}
function msg(el,text,good=false){
  el.textContent=text; el.classList.remove("hidden");
  el.style.background = good ? "#eef8f1" : "#fff2f2";
}
function toISO(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate()).toLocaleDateString("en-CA")}
function parseISO(s){const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function startOfWeek(d){const x=new Date(d);x.setDate(x.getDate()-x.getDay());x.setHours(0,0,0,0);return x}
function sameDay(a,b){return toISO(a)===toISO(b)}
function fmtDate(d,o={weekday:"long",month:"long",day:"numeric"}){return new Intl.DateTimeFormat("en-CA",o).format(d)}
function fmtTime(t){if(!t)return"";const[h,m]=t.split(":").map(Number);return new Intl.DateTimeFormat("en-CA",{hour:"numeric",minute:"2-digit"}).format(new Date(2000,0,1,h,m))}
function getPerson(id){return people.find(p=>p.id===id)||{name:"Family",color:"#777"}}
function occursOn(e,date){
  const d=toISO(date);
  if(e.recurrence==="none") return e.event_date===d;
  if(d < e.event_date) return false;
  if(e.recurrence_end && d > e.recurrence_end) return false;
  const start=parseISO(e.event_date);
  const diff=Math.round((date-start)/86400000);
  return e.recurrence==="daily" ? diff>=0 : e.recurrence==="weekly" ? diff>=0 && diff%7===0 : false;
}
function eventsFor(date){return rawEvents.filter(e=>occursOn(e,date)).sort((a,b)=>(a.start_time||"").localeCompare(b.start_time||""))}

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
}
async function loadData(){
  setSync("Syncing…",false);
  const [{data:p,error:pe},{data:e,error:ee}] = await Promise.all([
    supabase.from("people").select("*").eq("household_id",household.id).order("sort_order"),
    supabase.from("events").select("*").eq("household_id",household.id).order("event_date")
  ]);
  if(pe||ee){console.error(pe||ee);setSync("Sync error",false);return}
  people=p||[];rawEvents=e||[];setSync("Connected",true);
}
function subscribeRealtime(){
  if(realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel=supabase.channel(`household-${household.id}`)
    .on("postgres_changes",{event:"*",schema:"public",table:"events",filter:`household_id=eq.${household.id}`}, async()=>{await loadData();render()})
    .on("postgres_changes",{event:"*",schema:"public",table:"people",filter:`household_id=eq.${household.id}`}, async()=>{await loadData();render()})
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
  const p=getPerson(e.person_id),el=document.createElement("div");el.className="event";el.style.setProperty("--event-color",p.color);
  el.innerHTML=`<button class="event-delete">×</button><div class="event-time">${fmtTime(e.start_time)}${e.end_time?" – "+fmtTime(e.end_time):""}${e.recurrence!=="none"?" ↻":""}</div><div class="event-title"></div><div class="event-person"></div>`;
  el.querySelector(".event-title").textContent=e.title;el.querySelector(".event-person").textContent=p.name;
  el.querySelector(".event-delete").onclick=async ev=>{ev.stopPropagation();if(confirm(`Delete "${e.title}"${e.recurrence!=="none"?" and its repeating series":""}?`)){await supabase.from("events").delete().eq("id",e.id)}};
  return el;
}
function renderWeek(){
  const start=startOfWeek(cursor),end=addDays(start,6);
  $("rangeLabel").textContent=`${new Intl.DateTimeFormat("en-CA",{month:"short",day:"numeric"}).format(start)} – ${new Intl.DateTimeFormat("en-CA",{month:"short",day:"numeric",year:"numeric"}).format(end)}`;
  const wrap=document.createElement("div");wrap.className="week";
  for(let i=0;i<7;i++){const d=addDays(start,i),col=document.createElement("div");col.className="daycol"+(sameDay(d,new Date())?" today":"");
    col.innerHTML=`<div class="dayhead"><span class="dow">${new Intl.DateTimeFormat("en-CA",{weekday:"short"}).format(d)}</span><span class="dom">${d.getDate()}</span></div><div class="events"></div>`;
    const holder=col.querySelector(".events"),es=eventsFor(d);if(!es.length)holder.innerHTML='<div class="empty">No events</div>';es.forEach(x=>holder.appendChild(eventCard(x)));col.ondblclick=()=>openAdd(d);wrap.appendChild(col)}
  $("calendar").replaceChildren(wrap);
}
function renderDay(){
  $("rangeLabel").textContent=fmtDate(cursor);const wrap=document.createElement("div");wrap.className="day-view";
  people.forEach(p=>{const col=document.createElement("div");col.className="person-column";col.innerHTML=`<h3><span class="dot" style="background:${p.color}"></span>${p.name}</h3>`;
    const es=eventsFor(cursor).filter(e=>e.person_id===p.id);if(!es.length)col.insertAdjacentHTML("beforeend",'<div class="empty">Nothing scheduled</div>');es.forEach(e=>col.appendChild(eventCard(e)));wrap.appendChild(col)});
  $("calendar").replaceChildren(wrap);
}
function renderMonth(){
  const y=cursor.getFullYear(),m=cursor.getMonth(),start=startOfWeek(new Date(y,m,1));$("rangeLabel").textContent=new Intl.DateTimeFormat("en-CA",{month:"long",year:"numeric"}).format(cursor);
  const wrap=document.createElement("div");wrap.className="month";["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(x=>{const h=document.createElement("div");h.className="month-head";h.textContent=x;wrap.appendChild(h)});
  for(let i=0;i<42;i++){const d=addDays(start,i),cell=document.createElement("div");cell.className="month-day"+(d.getMonth()!==m?" outside":"")+(sameDay(d,new Date())?" today":"");cell.innerHTML=`<div class="month-num">${d.getDate()}</div>`;
    const es=eventsFor(d);es.slice(0,3).forEach(e=>{const p=getPerson(e.person_id),x=document.createElement("div");x.className="month-event";x.style.setProperty("--event-color",p.color);x.textContent=`${fmtTime(e.start_time)} ${e.title}`;cell.appendChild(x)});if(es.length>3)cell.insertAdjacentHTML("beforeend",`<div class="empty">+${es.length-3} more</div>`);cell.onclick=()=>{cursor=d;view="day";render()};wrap.appendChild(cell)}
  $("calendar").replaceChildren(wrap);
}
function renderToday(){
  const el=$("todayList");el.innerHTML="";const es=eventsFor(new Date());if(!es.length){el.innerHTML='<div class="empty">Nothing scheduled today.</div>';return}
  es.forEach(e=>{const p=getPerson(e.person_id),row=document.createElement("div");row.className="today-row";row.innerHTML=`<div class="today-time">${fmtTime(e.start_time)}</div><div><div class="today-name"></div><div class="event-person"><span class="dot" style="background:${p.color};margin-right:5px"></span>${p.name}</div></div>`;row.querySelector(".today-name").textContent=e.title;el.appendChild(row)})
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
function openAdd(d=new Date()){
  $("eventTitle").value="";$("eventDate").value=toISO(d);$("eventTime").value="17:00";$("eventEndTime").value="";$("eventRepeat").value="none";$("eventRepeatEnd").value="";$("repeatEndWrap").classList.add("hidden");$("eventDialog").showModal()
}
document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>$(b.dataset.close).close());
document.querySelectorAll(".view-switch button").forEach(b=>b.onclick=()=>{view=b.dataset.view;render()});
$("todayBtn").onclick=()=>{cursor=new Date();render()};
$("prevBtn").onclick=()=>{cursor=view==="month"?new Date(cursor.getFullYear(),cursor.getMonth()-1,1):addDays(cursor,view==="week"?-7:-1);render()};
$("nextBtn").onclick=()=>{cursor=view==="month"?new Date(cursor.getFullYear(),cursor.getMonth()+1,1):addDays(cursor,view==="week"?7:1);render()};
$("addBtn").onclick=()=>openAdd(cursor);
$("familyBtn").onclick=()=>{renderPeople();$("familyDialog").showModal()};
$("shareBtn").onclick=()=>{$("shareCode").textContent=household.join_code;$("shareDialog").showModal()};
$("copyCodeBtn").onclick=async()=>{await navigator.clipboard.writeText(household.join_code);$("copyCodeBtn").textContent="Copied!";setTimeout(()=>$("copyCodeBtn").textContent="Copy code",1200)};
$("eventRepeat").onchange=()=>{$("repeatEndWrap").classList.toggle("hidden",$("eventRepeat").value==="none")};
$("eventForm").onsubmit=async e=>{
  e.preventDefault();setSync("Saving…",false);
  const payload={household_id:household.id,person_id:$("eventPerson").value||null,title:$("eventTitle").value.trim(),event_date:$("eventDate").value,start_time:$("eventTime").value||null,end_time:$("eventEndTime").value||null,recurrence:$("eventRepeat").value,recurrence_end:$("eventRepeat").value==="none"?null:($("eventRepeatEnd").value||null),created_by:currentUser.id};
  const {error}=await supabase.from("events").insert(payload);if(error){alert(error.message);setSync("Save error",false);return}$("eventDialog").close()
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
