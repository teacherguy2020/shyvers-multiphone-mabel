# Project context

## Objective

Shyvers Multiplayer is a separate project for the multiplayer experience and
its supporting services. It has its own source, deployment, testing, and
configuration lifecycle.

The related Multiphone system remains the physical/customer-facing music
operator project. Its Mabel runtime, Mac bridge, Harmony integration, Pico
credit trigger, and Now Playing integration are maintained in the
[`now-playing`](https://github.com/teacherguy2020/now-playing) repository.

## Repository boundary

- Multiplayer-specific source and deployment files belong here.
- Multiphone/Mabel runtime files belong in `now-playing`.
- Shared concepts may be documented in both repositories, but operational
  details should have one authoritative home.
- Never commit passwords, API keys, tokens, certificates, or machine-local
  configuration.

## Status

This repository currently contains the project scaffold and documentation
context. Multiplayer implementation files will be added as the project is
organized.
