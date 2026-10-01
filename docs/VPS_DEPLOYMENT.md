# Single-VPS paper deployment

Target: Ubuntu/Debian-style Linux, Node.js 20+ API compatibility (use a supported LTS release), npm, git and tar. This is still virtual paper execution using public feeds only. No actual VPS is provisioned by these artifacts.

## Initial installation

Provision a dedicated non-root service user `tuyul`. An administrator installs Node and the systemd unit; the application itself never needs root. Install application source under `/opt/tuyul-ndase-ireng` owned by the deployment/service user. For example, after creating that user and writable application directory:

```sh
sudo -u tuyul git clone https://github.com/doubledwi2/tuyul-ndase-ireng.git /opt/tuyul-ndase-ireng
cd /opt/tuyul-ndase-ireng
sudo -u tuyul npm ci
sudo -u tuyul npm run build
sudo -u tuyul npm test
sudo install -d -o tuyul -g tuyul -m 0700 /var/lib/tuyul-paper
sudo install -m 0600 deploy/paper.env.example /etc/tuyul-paper.env
sudo install -m 0644 deploy/systemd/tuyul-paper.service /etc/systemd/system/tuyul-paper.service
sudo systemctl daemon-reload
sudo systemctl enable --now tuyul-paper
```

Before starting, adapt `WorkingDirectory`, `ExecStart`, `User`, `Group`, and `EnvironmentFile` to the host. Run `command -v node` to resolve the installed binary and use its absolute path; the unit does not load interactive-shell/nvm setup. Build requires dev dependencies (TypeScript). `npm run start:paper` runs compiled `dist/paper.js`; systemd invokes that same file directly so SIGTERM reaches Node. Run `systemd-analyze verify /etc/systemd/system/tuyul-paper.service` on the target host before enabling. The unit restarts failures after 10 seconds, limits restart loops, and allows 120 seconds for graceful flush. Tune stop timeout for measured storage performance.

## Observe

```sh
sudo systemctl status tuyul-paper
sudo journalctl -u tuyul-paper -f
curl -fsS http://127.0.0.1:8080/live
curl -i http://127.0.0.1:8080/ready
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/metrics
```

Readiness can be 503 during warm-up or timing/feed/persistence degradation while liveness remains 200. Keep health endpoints on localhost. Remote inspection can use `ssh -L 8080:127.0.0.1:8080 operator@vps`; do not open a public firewall port for health.

Operational summary is emitted every 60 seconds. Event loop delay is host/process delay in milliseconds, with a window reset after each summary. Resource metrics include RSS, heap, external memory, active orders/trades, journal bytes, pending writes, checkpoint age and disk space. The summary uses the structured logger; `LOG_FORMAT=json` suppresses high-frequency terminal comparison display. Configure journald retention (`SystemMaxUse`, `MaxRetentionSec`) according to host policy; no application log-file rotation is needed. Paper per-run JSONL is separate: archive/remove old completed runs offline according to your retention policy. Free-space protection blocks entries below 500 MB; it does not delete data automatically.

## Safe upgrade and rollback

```sh
sudo systemctl stop tuyul-paper
sudo journalctl -u tuyul-paper -n 30
cd /opt/tuyul-ndase-ireng
sudo -u tuyul env DATA_DIR=/var/lib/tuyul-paper npm run state:check
sudo -u tuyul env DATA_DIR=/var/lib/tuyul-paper npm run backup:state
git rev-parse HEAD
sudo -u tuyul git pull --ff-only
sudo -u tuyul npm ci
sudo -u tuyul npm run build
sudo -u tuyul npm test
sudo systemctl start tuyul-paper
curl -fsS http://127.0.0.1:8080/live
curl -i http://127.0.0.1:8080/ready
```

Verify `shutdown_complete`, no `runtime.lock`, and a valid final checkpoint before upgrading. Record the old commit SHA and backup filename. On first-ever startup `state:check` reports EMPTY until the initial checkpoint exists; that is not corruption. Always back up before schema changes. Do not replace data while the service is running.

For rollback, stop the service, preserve the current state with another backup, check out the recorded compatible commit, then repeat `npm ci`, build and tests. Validate state with that version before starting. Future incompatible schemas require an operator-selected compatible backup. Extract a trusted backup into a new private directory, run `DATA_DIR=/path/to/extracted npm run state:check`, then explicitly configure DATA_DIR to that directory. Never overwrite current state blindly. There is no automatic backup restore.

## State maintenance

`state:check` validates checkpoint plus journal, including reservation/referential invariants and sequence continuity, without connecting to exchanges or changing checkpoint/journal. Both maintenance tools briefly acquire the same runtime lock and therefore require a stopped service. `backup:state` creates `DATA_DIR/backups/state-<time>-<pid>.tar.gz`, containing only checkpoint, current journal and retained journal archives. Raw datasets and runtime locks are excluded. Operators own backup retention/off-host copies. The backup CLI invokes tar without a shell; the running application does not execute shell commands.

Lock diagnostics contain PID, hostname, start time and ownership token. A live PID, unknown process liveness, foreign hostname or malformed lock refuses startup. Dead local PID locks can be recovered. PID reuse conservatively blocks startup. A very short `runtime.lock.guard` directory serializes acquisition/removal; a crash inside lock maintenance leaves it fail-closed. After stopping all instances and checking PID/hostname and ownership, an operator may remove that stale guard; never delete it from an automated restart script. Use one local filesystem and one PID namespace per DATA_DIR; network/distributed locking is outside this phase.

Compaction occurs only after a durable checkpoint. Sequences stay monotonic across archives. Checkpoint plus current journal is authoritative; archives are retained for manual diagnostics and are never silently replayed over a newer checkpoint. Unknown schema, corruption or missing checkpoint with archives fails closed. Directory fsync after rename improves machine-crash durability, but filesystem/hardware semantics still matter. Unsupported directory sync is explicitly reported; other I/O errors degrade persistence.

See [time discipline](TIME_SYNC.md). systemd behavior reference: [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

## Phase 5.1 read-only credential delivery boundary

Keep `/etc/tuyul-paper.env` limited to non-secret operational settings, including `EXECUTION_MODE=paper`, `REAL_EXECUTION_ENABLED=false`, `EXECUTION_KILL_SWITCH=true`, and default `PRIVATE_READ_ENABLED=false`. Phase 5.1 optionally enables authenticated balance, permission, config and fee reads, never real execution. Read the [security boundary](SECURITY_BOUNDARY.md) and [private-read guide](PRIVATE_READ.md); use dummy files for setup tests.

For credential delivery, a systemd drop-in can map protected source files to the app's `_FILE` inputs. Enabled collection requires complete sets for both exchanges; the following conceptual fragment covers Bybit only and needs the analogous OKX entries:

```ini
[Service]
LoadCredential=bybit-key:/etc/tuyul/credentials/bybit-key
LoadCredential=bybit-secret:/etc/tuyul/credentials/bybit-secret
Environment=BYBIT_API_KEY_FILE=%d/bybit-key
Environment=BYBIT_API_SECRET_FILE=%d/bybit-secret
```

For OKX use three analogous credentials mapped to `OKX_API_KEY_FILE`, `OKX_API_SECRET_FILE`, and `OKX_API_PASSPHRASE_FILE`. Keep source files outside DATA_DIR and the checkout, root-owned 0600 with private parent directories. systemd supplies service-readable files; the application still runs non-root. Do not set the corresponding direct environment names at the same time. This template is not installed or activated automatically and has not been tested on a target VPS.

systemd supports the `%d` credential-directory specifier in unit Environment entries; do not expect expansion in an EnvironmentFile. See the [official systemd credential documentation](https://systemd.io/CREDENTIALS/). On a host without credential support, a separate root-owned 0600 EnvironmentFile is a fallback, with environment-inheritance limitations. Never commit that file. Run `systemd-analyze verify` on the target unit/drop-in; start with dummy values and PRIVATE_READ_ENABLED=false.

After build, `npm run execution:check` performs presence/shape checks locally; it does not authenticate, sign or contact an exchange. `account:check` authenticates only when PRIVATE_READ_ENABLED=true and both credential sets exist. It exits nonzero for unsafe/unknown permissions, unsupported/unverified account semantics, or failed/stale required reads. Use minimum-permission read-only keys, never trade/withdraw. Supplying credentials or disabling the kill switch never enables real execution. `npm run secret:scan` can be part of an optional operator-managed pre-commit check.
