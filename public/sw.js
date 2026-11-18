const V="sd-v12";const CORE=["/","/index.html","/style.css","/app.js","/lib.js","/manifest.webmanifest","/icon.svg","/icon-192.png","/icon-512.png","/vendor/pdf.min.mjs","/vendor/pdf.worker.min.mjs"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);
if(e.request.method==="POST"&&u.origin===location.origin&&u.pathname==="/share-target"){e.respondWith((async()=>{try{const fd=await e.request.formData();const c=await caches.open("sd-share");for(const k of await c.keys())await c.delete(k);let i=0;for(const f of fd.getAll("pdfs")){if(f&&f.name!==undefined){await c.put("/shared/"+(i++)+"/"+encodeURIComponent(f.name||"shared.pdf"),new Response(f,{headers:{"Content-Type":"application/pdf"}}))}}}catch(x){}return Response.redirect("/?shared=1",303)})());return}
if(e.request.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api/"))return;
e.respondWith(fetch(e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(V).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match("/index.html"))))});
