const CACHE="family-hub-v3";
const ASSETS=[
  "./", "./index.html", "./styles.css", "./app.js", "./app.js?v=3", "./config.js", "./manifest.webmanifest",
  "./lib/calendar-domain.js", "./lib/google-event-model.js", "./lib/google-ui.js", "./lib/sync-policy.js"
];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener("activate",e=>e.waitUntil(
  caches.keys()
    .then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
    .then(()=>self.clients.claim())
));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  e.respondWith(fetch(e.request)
    .then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r})
    .catch(()=>caches.open(CACHE).then(cache=>cache.match(e.request))));
});
