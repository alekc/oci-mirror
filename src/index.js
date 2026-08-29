const UPSTREAM = "https://registry.gitlab.com";
const BACKEND_PREFIX = "alexander-chernov/helm/charts-oci";
const SELF_SERVICE = "oci-mirror";

// Matches /v2/<name>/<manifests|tags|blobs suffix>, name may contain
// slashes. Anything else under /v2/ (e.g. uploads) isn't a read op
// and is rejected before this ever runs, see the method check below.
const PATH_RE = /^\/v2\/(.+)\/(manifests\/[^/]+|tags\/list|blobs\/[^/]+)$/;

function parseAuthenticate(header) {
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = header.match(re);
  if (!matches || matches.length < 2) {
    throw new Error(`invalid WWW-Authenticate header: ${header}`);
  }
  return { realm: matches[0], service: matches[1] };
}

// The vanity ref (oci://charts.alekc.dev/<name>) has no group/project
// path, so the real GitLab repo path has to be reconstructed here.
function rewriteScope(scope) {
  if (!scope) return scope;
  const parts = scope.split(":");
  if (parts.length === 3 && parts[0] === "repository") {
    parts[1] = `${BACKEND_PREFIX}/${parts[1]}`;
    return parts.join(":");
  }
  return scope;
}

function rewritePathForUpstream(pathname) {
  const match = pathname.match(PATH_RE);
  if (!match) return null;
  const [, name, rest] = match;
  return `/v2/${BACKEND_PREFIX}/${name}/${rest}`;
}

function unauthorized(url) {
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: {
      "Www-Authenticate": `Bearer realm="https://${url.hostname}/v2/auth",service="${SELF_SERVICE}"`,
      "Content-Type": "application/json",
    },
  });
}

async function handleAuth(url) {
  const probe = await fetch(`${UPSTREAM}/v2/`, { method: "GET" });
  if (probe.status !== 401) return probe;

  const authenticate = probe.headers.get("WWW-Authenticate");
  if (!authenticate) return probe;

  const { realm, service } = parseAuthenticate(authenticate);
  const scope = rewriteScope(url.searchParams.get("scope"));
  const tokenUrl = new URL(realm);
  if (service) tokenUrl.searchParams.set("service", service);
  if (scope) tokenUrl.searchParams.set("scope", scope);
  return fetch(tokenUrl.toString());
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Pull-only mirror: no write credentials live here at all, so
    // rejecting non-read methods up front is a clean boundary, not
    // just a formality.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("read-only mirror", { status: 405 });
    }

    if (url.pathname === "/" ) {
      return Response.redirect(`${url.origin}/v2/`, 301);
    }

    if (url.pathname === "/v2/" || url.pathname === "/v2") {
      const resp = await fetch(`${UPSTREAM}/v2/`, { method: request.method });
      if (resp.status === 401) return unauthorized(url);
      return resp;
    }

    if (url.pathname === "/v2/auth") {
      return handleAuth(url);
    }

    const upstreamPath = rewritePathForUpstream(url.pathname);
    if (!upstreamPath) {
      return new Response("not found", { status: 404 });
    }

    const headers = new Headers();
    const auth = request.headers.get("Authorization");
    if (auth) headers.set("Authorization", auth);

    const resp = await fetch(UPSTREAM + upstreamPath, {
      method: request.method,
      headers,
      redirect: "follow",
    });

    if (resp.status === 401) return unauthorized(url);
    return resp;
  },
};
