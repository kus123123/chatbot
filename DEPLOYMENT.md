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
- `SERVER_SSH_KEY`: private SSH key used by GitHub Actions

## One-Time SSH Key Setup
Use a dedicated key for deploy automation.

1. Generate key pair locally:
```bash
ssh-keygen -t ed25519 -C "github-actions-chatbot" -f ~/.ssh/chatbot_deploy
```
2. Add public key to the server:
```bash
ssh-copy-id -i ~/.ssh/chatbot_deploy.pub naruto@76.13.247.66
```
3. Add private key to GitHub secret `SERVER_SSH_KEY`:
```bash
cat ~/.ssh/chatbot_deploy
```

## Manual Trigger
You can also run deployment manually from Actions using `workflow_dispatch` on `CI-CD`.
