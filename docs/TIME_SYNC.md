# VPS time discipline

The VPS must have a functioning NTP service such as chrony. Configure it at the operating-system level; the Node application never adjusts the system clock or runs chronyc.

An operator can inspect an Ubuntu/Debian host manually:

```sh
timedatectl status
systemctl status chrony
chronyc tracking
chronyc sources -v
chronyc sourcestats -v
```

Inspect synchronization state, selected time sources, last update, offset and frequency stability. Investigate unsynchronized status or sudden changes before trusting timing quality. Do not run competing clock-correction daemons. Service package names can differ by distribution.

SourceClockOffsetEstimator is a rolling diagnostic for observed ingress, not clock correction. Exchange timestamps do not prove synchronized clocks, and network delay contributes to observed ingress. A stable estimator and SYNC_HEALTHY are engineering qualifications, not guarantees about physical one-way latency or execution. Event-loop delay in /metrics measures local process scheduling and is separate from exchange/network latency.

Command reference: [official chronyc documentation](https://chrony-project.org/doc/4.6/chronyc.html).
