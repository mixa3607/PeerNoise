# PeerNoise

[![CI](https://img.shields.io/github/actions/workflow/status/mixa3607/PeerNoise/image.yaml?branch=master&style=flat-square)](https://github.com/mixa3607/PeerNoise/actions/workflows/image.yaml)
[![Container](https://img.shields.io/badge/GHCR-peernoise-blue?style=flat-square&logo=github)](https://github.com/mixa3607/PeerNoise/pkgs/container/peernoise)
[![License](https://img.shields.io/github/license/mixa3607/PeerNoise?style=flat-square)](LICENSE)

> **Warning: this is a 99% vibecoded piece of code.** Treat it as an experiment,
> not audited privacy or security software. Review it before trusting it.

A small Deno experiment that picks random RSS/Atom entries, announces its
address to BitTorrent DHT and HTTP/UDP trackers, and answers incoming BitTorrent
handshakes. It does not request or serve file blocks, pretend to be a seed, or
report completed downloads.

**Appearance on IKnowWhatYouDownload is not guaranteed.** The service may not
monitor the selected swarms, and announcements or handshakes may not satisfy its
checks. PeerNoise cannot pass content verification and is not an anonymity tool.

## Quick start

Requires Deno 2.

```sh
cp samples/config.yaml config.yaml
deno task start
# Use a different configuration file:
deno task start my-config.yaml
```

TCP and UDP share the configured BitTorrent port. Allow and forward TCP for
incoming peer connections and UDP for inbound DHT connectivity. UPnP is not
implemented. Observers see the public IP used by the machine's routing; a VPN
changes that address.

## Configuration

`samples/config.yaml` includes three feeds and an example HTTP proxy. The
working `config.yaml` in the project root is ignored by Git.

```yaml
port: 6881
metrics:
  host: 0.0.0.0
  port: 9090
refresh_minutes: 30
count: 5
feeds:
  - url: https://feed.rutracker.cc/atom/f/0.atom
    proxy: http://192.168.1.200:2080
  - url: https://sukebei.nyaa.si/?page=rss
    proxy: http://192.168.1.200:2080
  - url: https://fosstorrents.com/feed/torrents.xml
    count: 3
```

- `count` is the number of random entries **per feed**, not a global limit. Each
  feed can override it (1–100). Identical infohashes across feeds are announced
  only once.
- Refresh runs immediately, then `refresh_minutes` (1–1440) after the previous
  cycle completes. Each cycle selects a new random subset; some entries may
  stay. Removed torrents stop being announced and new ones become active.
- If a feed fails or no entries can be resolved, its previous selection is kept.
  Partial success may produce fewer than `count` torrents. Each cycle tries at
  most `count * 3` candidates per feed.
- Restart the process after changing the configuration. The old positional
  `port count` command-line format has been replaced by YAML.

### Feed formats and limitations

Supports RSS enclosures/links, Atom links, magnets in descriptions or linked
pages, and direct `.torrent` files. Pages without an accessible magnet or
torrent link are skipped. Authentication, CAPTCHA bypass, and JavaScript
rendering are not implemented. RuTracker topic resolution depends on the page
and proxy; the Atom feed alone does not guarantee access to an infohash.

Torrent files marked `private=1` are skipped. A magnet's privacy status is
unknown without metadata; magnets are used for DHT only, without fetching
metadata or announcing to trackers. Magnets without a known size are logged as
`[DHT only]` to avoid inventing tracker statistics.

Only feeds, small pages, and `.torrent` metadata are fetched, never ISO images
or other payloads. DHT announcements repeat every 20 minutes; the tracker
library uses its intervals and server responses. Ctrl+C shuts down the process.
Old DHT records may persist after removal, and tracker stop requests are
best-effort.

No database, outgoing BitTorrent peer connections, or web UI. DistroWatch's feed
can also be added: https://distrowatch.com/news/torrents.xml

## Proxies and DHT

A per-feed `proxy` covers **the feed and its linked pages/torrent files**,
including redirects. If that proxy fails, there is no direct fallback. It does
**not** proxy DHT, peer connections, or tracker announcements.

BitTorrent DHT uses UDP. A conventional HTTP proxy, including an ordinary HTTP
CONNECT proxy, cannot transport it. The `http://192.168.1.200:2080` URL alone
does not establish whether the service exposes any additional UDP-capable
protocol.

Options for routing DHT through another exit:

- **VPN/TUN or a VPN container/network namespace:** the simplest deployment
  option. Route PeerNoise's UDP and TCP traffic through the tunnel. For leak
  prevention, block direct egress when the tunnel is down. Port forwarding at
  the exit is needed if incoming peer connections must work.
- **SOCKS5 with UDP ASSOCIATE:** possible in principle, but requires UDP support
  on the proxy and a SOCKS-aware UDP transport integration. PeerNoise does not
  currently implement it. A plain SOCKS TCP connection or `HTTP_PROXY`
  environment variable is not sufficient. Ordinary TCP proxy wrappers do not
  redirect DHT.

Routing only DHT through a proxy does not hide the direct tracker or peer
traffic. The advertised peer port must also be reachable at the advertised exit
address for incoming handshakes to work. Moving the exit creates noise for that
exit IP, not necessarily for the home IP you originally wanted to associate with
swarms.

## Project layout

- `src/main.ts`: configuration, startup, and shutdown.
- `FeedScheduler` (`src/feed_scheduler.ts`): periodic refresh, random selection,
  and retaining previous selections on failure.
- `FeedReader` (`src/feed_reader.ts`): HTTP, per-feed proxies, and resolving
  feed entries into torrent information.
- `src/feed_parser.ts`: RSS/Atom and link parsing.
- `TorrentSession` (`src/torrent_session.ts`): DHT, trackers, incoming
  connections, and active torrent lifecycle.
- `src/protocol.ts`: handshake handling without file block requests.
- `Metrics` (`src/metrics.ts`): Prometheus registry and HTTP `/metrics`.
- `src/tests/`: local tests.
- `samples/config.yaml`: example configuration.

## Prometheus

`GET http://127.0.0.1:9090/metrics` returns Prometheus text exposition. Without
a `metrics` section, the server listens on `127.0.0.1:9090`. The sample uses
`0.0.0.0:9090` for Docker access. **There is no authentication:** restrict
access with a firewall or publish the Docker port on localhost only.

All metric names use the `peernoise_` prefix:

- `active_torrents`, `connections`, `handshakes_total{result}`.
- `dht_announces_total{result}`, `tracker_responses_total`,
  `network_warnings_total{source}`.
- `rss_refreshes_total{feed,result}`, `rss_entries{feed}`, `rss_selected{feed}`,
  `rss_resolve_errors_total{feed}`.
- `rss_last_success_timestamp_seconds{feed}` (0 before the first success),
  `rss_refresh_duration_seconds{feed}` (histogram).

`feed` is the zero-based index in the YAML feed list. URLs, passkeys, proxies,
and infohashes are not included in labels. Successful DHT announcements do not
prove that a monitoring service observed them.

**Rename migration:** the former `torrent_spy_` metric prefix is now
`peernoise_`. Update existing queries, alerts, dashboards, and image references
accordingly.

```yaml
scrape_configs:
  - job_name: peernoise
    static_configs:
      - targets: ["127.0.0.1:9090"]
```

The target address must be reachable from the Prometheus process or container.

## Docker

GitHub Actions checks, tests, and publishes a Linux amd64 image to
`ghcr.io/mixa3607/peernoise` on every push. Branch and commit (`sha-...`) tags
are published; Git tag pushes also produce matching image tags. `latest` tracks
the default branch only. Builds use the repository's `GITHUB_TOKEN` with
`packages: write`; no separate registry secret is required.

```sh
docker pull ghcr.io/mixa3607/peernoise:latest
```

GHCR packages may initially be private. The repository owner can change the
package visibility to public in GitHub's package settings; otherwise consumers
need to log in with package read access.

To run the published image:

```sh
cp samples/config.yaml config.yaml
docker run --rm --name peernoise \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -p 6881:6881/tcp -p 6881:6881/udp \
  -p 127.0.0.1:9090:9090 \
  ghcr.io/mixa3607/peernoise:latest
```

The container runs as a non-root user. Dependencies are cached at build time;
configuration is mounted separately. The proxy at `192.168.1.200:2080` must be
reachable from the container network. If YAML ports change, update `-p` as well;
the external BitTorrent port must match the advertised internal port. To use a
different configuration path, pass it after the image name.

On Linux, `--network host` can replace `-p`. With host networking,
`metrics.host: 0.0.0.0` exposes metrics on all host interfaces. Host networking
does not itself provide a VPN or proxy.

`build-image.sh` is standalone: Docker Buildx, OCI labels, a Git-derived tag (or
`dev`), and logs under `logs/`. By default, the image is loaded locally with
`--load`. Pushing requires an explicit opt-in:

```sh
TAG=local ./build-image.sh
# Manual publishing (log in to the target registry first):
PUSH=1 TAG=latest ./build-image.sh
# Multi-platform builds need a configured builder with QEMU or native workers.
PUSH=1 TAG=latest PLATFORMS=linux/amd64,linux/arm64 ./build-image.sh
./build-image.sh --help
```

## Compose and Kubernetes examples

### Docker Compose

```sh
docker compose -f samples/docker-compose.yaml up -d
docker compose -f samples/docker-compose.yaml logs -f
docker compose -f samples/docker-compose.yaml down
```

Compose mounts `samples/config.yaml` read-only. Edit that file or copy the
Compose file and config together elsewhere; paths are relative to the Compose
file. Restart the service after changing the config. To use a pinned image:

```sh
PEERNOISE_IMAGE=ghcr.io/mixa3607/peernoise:sha-edabbe8 \
  docker compose -f samples/docker-compose.yaml up -d
```

Metrics are published on localhost only. The healthcheck tests `/metrics`, not
feed availability or visibility to torrent observers. Keep published ports and
the healthcheck URL in sync if you change `config.yaml`. Docker marks failed
healthchecks unhealthy but does not automatically restart a running unhealthy
process; the restart policy covers process exits.

### Helm release

`samples/chart` is a minimal Helm chart with a Deployment, ConfigMap, and
Service. It uses one replica and `Recreate` upgrades to avoid duplicated
activity. Config changes trigger a restart through a pod-template checksum. No
PVC, Ingress, or Kubernetes API permissions are required. Probes test the
metrics HTTP endpoint; RSS outages do not cause restart loops.

```sh
helm upgrade --install peernoise ./samples/chart \
  --namespace peernoise --create-namespace
# Override settings with your own values file:
helm upgrade --install peernoise ./samples/chart \
  --namespace peernoise --values my-values.yaml
kubectl -n peernoise port-forward service/peernoise 9090:9090
```

Edit the chart's `config` values to supply feeds/proxies; the default only uses
FOSS Torrents. These values become a ConfigMap, **not a Secret**. Do not put
credentials or private tracker passkeys in this example. For a private GHCR
package, configure `imagePullSecrets` with an existing registry Secret.

The default Service is ClusterIP: it exposes TCP/UDP BitTorrent and TCP metrics
inside the cluster, **not on the public internet**. Outbound DHT works subject
to cluster networking/firewall rules; incoming peer connections require a
reachable exit address with matching port forwarding. Changing the Service to
NodePort or LoadBalancer alone does not guarantee that its address matches the
outgoing DHT source address, and a default NodePort changes the external port
number.

For a suitable Linux node, `--set hostNetwork=true` uses the node network and
`ClusterFirstWithHostNet` DNS. The configured BitTorrent port must be free and
reachable through the node's firewall/router. This also exposes metrics on the
node interface when `metrics.host` is `0.0.0.0`; restrict access separately.
Some clusters prohibit host networking. This is not a VPN/proxy feature.

The chart includes resource requests/limits and targets amd64 nodes because the
published image is currently amd64-only. An empty `image.tag` uses the chart's
`appVersion`: `latest` in local sources, a pinned `sha-...` tag in CI packages.
Set `image.tag` explicitly to override that default.

### OCI chart in GHCR

After a successful image build, Actions lints, packages, and publishes the chart
to `oci://ghcr.io/mixa3607/charts/peernoise`. Each run produces a unique
version: `<Chart.yaml version>-dev.<run number>.<attempt>`, for example
`0.1.0-dev.12.1`. The packaged `appVersion` references the image built from the
same Git commit. The exact chart version and install command are printed in the
workflow summary.

```sh
# Replace the example version with one from a successful workflow summary.
helm upgrade --install peernoise oci://ghcr.io/mixa3607/charts/peernoise \
  --version 0.1.0-dev.12.1 \
  --namespace peernoise --create-namespace \
  --values my-values.yaml
```

These are development chart versions, not GitHub releases. Always specify the
version explicitly: Helm does not select prereleases by default. The OCI chart
and container image are separate GHCR packages; configure public visibility for
both if unauthenticated pulls are desired. For private charts, use
`helm registry login ghcr.io` with a token that has package read access.

## Checks

```sh
deno task test
deno task check
```

Tests cover handshakes without downloads, rejection of unknown infohashes,
RSS/Atom parsing, configuration validation, refresh/recovery behavior, proxy
request routing, and Prometheus exposition. They do not announce addresses to
the public BitTorrent network.
