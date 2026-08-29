# oci-mirror

A Cloudflare Worker that fronts `charts.alekc.dev/v2/*` and proxies it to
[`alexander-chernov/helm/charts-oci`](https://gitlab.com/alexander-chernov/helm/charts-oci) on
`registry.gitlab.com`, so Helm charts can be pulled as `oci://charts.alekc.dev/<chart-name>`
without exposing the real backend project path.

## Why

`charts.alekc.dev` already serves the classic `index.yaml`/S3 chart repository. Neither
GitLab.com, GHCR, nor Quay.io support a custom domain for their container registry, so this
Worker adds `oci://` support on the same hostname instead: the OCI Distribution Spec reserves
the whole API under `/v2/*`, which never collides with the classic repo's plain paths
(`/index.yaml`, `/<chart>-<version>.tgz`).

## How it works

The OCI/Docker Registry HTTP API v2 needs more than a byte-for-byte reverse proxy, because the
bearer-token auth handshake has to stay under this domain too:

1. `GET /v2/` is forwarded as-is. If the real registry answers 401, this Worker rewrites the
   `WWW-Authenticate` realm to point back at its own `/v2/auth`, not GitLab's real token
   endpoint.
2. `GET /v2/auth` re-probes the real registry to read its actual realm/service, rewrites the
   `scope` parameter to inject the real repo path (`alexander-chernov/helm/charts-oci/<name>`,
   since the vanity ref has no group/project segment), and fetches the token from GitLab
   directly. The token returned to the client was genuinely issued by GitLab for that
   repository.
3. Manifest, tag-list, and blob `GET`/`HEAD` requests get the same path prefix injected, then get
   forwarded straight through, redirects included.

## Scope

Pull-only. No write credentials live in this Worker or its deployment: `GET`/`HEAD` are the only
methods handled, everything else gets a 405. Publishing charts happens directly from GitLab CI
against the real registry, this Worker is purely a public read-side mirror.

## Deploy

Connected to Cloudflare Workers Builds via the GitHub integration, scoped to this repository
only. Every push to `main` builds and deploys automatically.

Part of [ALE-64](https://linear.app/alekc/issue/ALE-64/migrate-helm-chart-distribution-to-oci-registries).
