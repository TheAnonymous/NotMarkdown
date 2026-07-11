const APP_CACHE = "notmarkdown-studio-v3";
const SHARE_CACHE = "notmarkdown-share-target-v1";
const SCOPE = self.registration.scope;
const ROOT = new URL("./", SCOPE).href;
const SHARE_ACTION = new URL("share-target", SCOPE).href;
const SHARED_FILE = new URL("__notmarkdown_share_target__", SCOPE).href;
const SHELL = [
  ROOT,
  new URL("manifest.webmanifest", SCOPE).href,
  new URL("icon.svg", SCOPE).href
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith("notmarkdown-studio-") && name !== APP_CACHE
            )
            .map((name) => caches.delete(name))
        )
      )
    ])
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "POST" && url.href === SHARE_ACTION) {
    event.respondWith(storeSharedFile(event.request));
    return;
  }

  if (event.request.method === "GET" && url.href === SHARED_FILE) {
    event.respondWith(takeSharedFile());
    return;
  }

  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type !== "opaque") {
          const copy = response.clone();
          void caches
            .open(APP_CACHE)
            .then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

async function storeSharedFile(request) {
  const form = await request.formData();
  const files = form.getAll("documents");
  const file = files.find(
    (candidate) =>
      typeof candidate !== "string" &&
      /\.(?:nmdoc|nmt)$/i.test(candidate.name || "")
  );

  if (!file) {
    return Response.redirect(new URL("./?share-target=1", SCOPE), 303);
  }

  const cache = await caches.open(SHARE_CACHE);
  await cache.put(
    SHARED_FILE,
    new Response(file, {
      headers: {
        "Content-Type": file.type || mediaTypeFor(file.name),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-NotMarkdown-Filename": encodeURIComponent(file.name)
      }
    })
  );
  return Response.redirect(new URL("./?share-target=1", SCOPE), 303);
}

async function takeSharedFile() {
  const cache = await caches.open(SHARE_CACHE);
  const response = await cache.match(SHARED_FILE);
  if (!response) {
    return new Response("No shared NotMarkdown file is waiting.", {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }
  await cache.delete(SHARED_FILE);
  return response;
}

function mediaTypeFor(name) {
  return name.toLowerCase().endsWith(".nmdoc")
    ? "application/vnd.notmarkdown.document+zip"
    : "text/vnd.notmarkdown.source";
}
