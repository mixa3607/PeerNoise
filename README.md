# PeerNoise

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

```sh
TAG=local ./build-image.sh
cp samples/config.yaml config.yaml
docker run --rm --name peernoise \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -p 6881:6881/tcp -p 6881:6881/udp \
  -p 127.0.0.1:9090:9090 \
  docker.io/mixa3607/peernoise:local
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
PUSH=1 TAG=latest ./build-image.sh
# Multi-platform builds need a configured builder with QEMU or native workers.
PUSH=1 TAG=latest PLATFORMS=linux/amd64,linux/arm64 ./build-image.sh
./build-image.sh --help
```

## Checks

```sh
deno task test
deno task check
```

Tests cover handshakes without downloads, rejection of unknown infohashes,
RSS/Atom parsing, configuration validation, refresh/recovery behavior, proxy
request routing, and Prometheus exposition. They do not announce addresses to
the public BitTorrent network.
