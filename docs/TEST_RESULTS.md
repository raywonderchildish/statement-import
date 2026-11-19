# Результаты автотестов

Дата прогона: 2026-11-18. Node v22.22.0, macOS 26.6.2.

## Клиент: `cd app && npm test`

```text
matrix.test.ts
  PASS  happy > statement.csv: real bytes are sent, 202 is not a report, ready shows mock data
  PASS  happy > statement.pdf: real bytes are sent, 202 is not a report, ready shows mock data
  PASS  happy > accepts a non-ASCII file name
  PASS  persisted key > stores the key and the operation before the first POST and sends that same key
  PASS  lost_ack > retry in the same session finds the job by key: one job, no second POST
  PASS  lost_ack > relaunch recovers the job by the stored key without re-sending the file
  PASS  lost_ack > when the lookup races and says 404, the re-POST uses the same key and still yields one job
  PASS  relaunch > does not send the file on its own when the POST never left the device
  PASS  relaunch > shows the current job after a normal relaunch without any POST
  PASS  relaunch > removes a private copy left behind by a crash
  PASS  leaving an uncertain import > does not abandon when the server turns out to have the job
  PASS  leaving an uncertain import > keeps the key when the server is unreachable and deletes the server job on later launches
  PASS  leaving an uncertain import > drops the key once the server says no such job exists
  PASS  edge cases found in review > sends nothing and leaves no trace when the key cannot be stored
  PASS  edge cases found in review > treats an unexpected success code on create as unknown, not as a refusal
  PASS  edge cases found in review > keeps the key for clean-up when the copy needed for a retry has vanished
  PASS  edge cases found in review > ignores a stored record with an unknown phase instead of showing a dead-end screen
  PASS  edge cases found in review > can show the stored job without waiting for the abandoned clean-up
  PASS  stale_status > keeps ready/revision 3 when processing/revision 2 arrives afterwards
  PASS  delete > 202 means deleting; deleted is reported only after a confirming GET
  PASS  delete > delete_failure: a 503 never claims deletion; the same key succeeds after switching to happy
  PASS  delete > a late ready answer does not resurrect a deleted job
  PASS  delete > a job the server no longer knows is reported as missing, not as deleted
  PASS  spoofed + oversize > rejects both files locally: createRequests does not change and no copy remains
  PASS  spoofed + oversize > stops copying an oversize file whose size is unknown up front
  PASS  spoofed + oversize > releases the picked source in every outcome so a system-made copy never lingers
  PASS  spoofed + oversize > rejects a real CSV renamed to .pdf
  PASS  privacy > logs contain no file name, key, or merchant description
ui.test.ts
  PASS  screenFor: what the UI is allowed to claim > shows nothing as ready before the server says ready
  PASS  screenFor: what the UI is allowed to claim > never shows deleted for an accepted, failed, or unknown deletion
  PASS  screenFor: what the UI is allowed to claim > keeps an uncertain create distinct from an error and from success
  PASS  screenFor: what the UI is allowed to claim > polls only while the server is expected to change the job
  PASS  screenFor: what the UI is allowed to claim > flags a failed delete only while the job still exists
  PASS  formatting > formats money from minor units without floats
  PASS  formatting > formats dates and sizes
validate.test.ts
  PASS  detectFormat > recognises the kit fixtures by content
  PASS  validateFile > applies the 10 MiB limit inclusively
  PASS  validateFile > rejects empty files and trusts content over a missing extension
  PASS  encodeFileNameHeader > keeps ASCII, encodes the rest, and falls back when too long
  PASS  parseJobView > refuses malformed answers instead of guessing
  PASS  sanitizeFields > drops unknown keys and free text

Suites: 3/3 passed. Tests: 41/41 passed, 0 failed.
```

## Mock из набора, без изменений: `cd mobile-engineer-kit && npm test`

```text
ok 1 - same key and bytes produce one job; changed bytes conflict
ok 2 - lost acknowledgement is recoverable by key
ok 3 - stale status follows ready, and failed delete does not claim deletion
ok 4 - rejects spoofed and oversized files
ok 5 - accepts the shared PDF fixture as real bytes
ok 6 - job metadata survives a mock process restart
# tests 6
# pass 6
# fail 0
```
