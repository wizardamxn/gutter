# Working rules for this project

## Decisions belong to the owner
Before implementing any of the following, stop and ask me. Give 2-3 options, the
trade-offs, and your recommendation. Do not implement until I say which:
- adding, removing or reordering a model call (anything that runs an AI model)
- changing what the model sees: routing, retrieval, prompt structure, context size
- anything that sends data off the user's device, or a new external service or download
- what is stored, where, and for how long
- new dependencies, or a different model/backend/device (e.g. WebGPU vs wasm)
- pricing, limits, accounts, security or privacy behaviour
- user-visible behaviour or UX flow

If a task says "try options and keep whichever works", test them and report the
numbers, but do NOT ship the winner until I approve it.

Tuning a constant within an already-approved design is fine without asking, but list
every change in your final report.

## Decision log
Keep DECISIONS.md at the repo root. One entry per decision:
date | decision | why | alternatives rejected | approved by me: yes / not yet
Every report you write ends with the list of decisions made in that task.

## First task
Create DECISIONS.md from ARCHITECTURE.md and the current code. List every design
decision already in place (routing, query rewrite, code refusal, code-attributed sources,
3,500-token switch, sampling settings, windows, WebGPU indexing, Hugging Face model
download, server proxying smart answers, unencrypted local API keys, per-account free
limit, etc.). Mark them all "not yet" and wait for my review. Don't change any code.