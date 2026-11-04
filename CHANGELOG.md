# Changelog

## 0.2.0 (2026-11-04)

- Before the first reply, the context reads `0 0%` with an empty bar instead of `--`.
- A 5-hour or weekly window drops to 0% the moment it resets, without waiting for the next reply. While idle, the meter also re-reads usage once an hour.

## 0.1.0 (2026-11-04)

First release.

- A one-line meter above the Claude Code prompt: context size, 5-hour and weekly limits, prompt-cache reuse and session cost.
- Colors by level: context by token count (100k / 200k), limits by percent used (50% / 80%).
- Bars hide in terminals narrower than 90 columns.
- Works with Claude Code 2.1.281 and newer.
