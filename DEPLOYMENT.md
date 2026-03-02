# Deployment Automation

This repo uses GitHub Actions workflow `.github/workflows/ci-cd.yml`.

## What It Does
- On pull requests to `main`: installs dependencies, runs `pnpm run test:server`, and runs `pnpm run build`.
- On pushes to `main`: runs the same CI checks, then deploys to `naruto@76.13.247.66` and restarts `pm2` process `chatbot`.

## Required GitHub Secrets
Add these in GitHub repository settings: `Settings -> Secrets and variables -> Actions`.

- `SERVER_HOST`: `76.13.247.66`
- `SERVER_PORT`: `22` (optional; defaults to `22`)
- `SERVER_USER`: `naruto`
- `SERVER_PASSWORD`: SSH password for `naruto`

## Password-Based Deploy
This workflow currently deploys using password authentication via `sshpass`.

Recommended later: migrate to SSH key auth for better security.

## Manual Trigger
You can also run deployment manually from Actions using `workflow_dispatch` on `CI-CD`.
