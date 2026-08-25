# ReplayGain analysis contract

Oscine computes missing values with ReplayGain 2.0 semantics:

- decoded PCM is K-weighted and measured in overlapping 400 ms BS.1770 blocks;
- the absolute -70 LUFS and relative -10 LU gates are applied;
- track and album gain target -18 LUFS;
- peak is the maximum absolute decoded sample, stored as a linear ratio;
- gains are decibels.

The deterministic reference fixture is a two-second, 1 kHz mono sine at 48 kHz and 0.2 peak. Its
expected result is -1.00 dB track gain within 0.10 dB and 0.2000 peak within 0.002. The pure DSP
tests additionally require a doubling of amplitude to change measured gain by 6.0206 dB within
0.1 dB.

`node-web-audio-api` is the decode adapter. It is a production dependency with Node-API binaries
for Windows and Linux; analysis does not invoke ffmpeg or another machine-installed executable.
`replayGainWorker.js` is a named main-build entry and all native modules are unpacked from the
application archive. The post-build `npm run probe:replaygain` check sends the reference WAV
through that exact emitted worker. CI runs the probe on both Windows and Linux.

## Job and retry behavior

The queue uses two worker threads. A completed track is committed immediately, including the
compact loudness histogram needed for later album calculation. Cancellation terminates active
workers, returns interrupted items to `pending`, and keeps completed items. An app shutdown records
the job as `paused` before awaiting worker cleanup; resume reads the same item checkpoints after
SQLite is reopened.

Tagged rows are never queued. Every computed write is also guarded by `rg_source IS NULL`, so a
real tag discovered by a concurrent rescan wins. Per-file decode failures are recorded with a
path-free message and are not retried by resume. Starting a fresh job retries only tracks that
still have no result.

Album gain is written only when every indexed member has a usable track result. Failed albums keep
successful track values and remain without album gain. A later fresh job can analyze the failed
members and finalize the album from histograms retained by prior jobs.
