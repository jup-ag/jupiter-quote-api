# Jupiter Quote API

This is the same code that we use to host our Jupiter API on [fly.io](https://fly.io).

## Prerequisite
- [redis](https://redis.io/docs/getting-started/installation/install-redis-on-mac-os/)

## How to run
1. `pnpm install`
2. `RPC_URL=xxxxxxx pnpm start`

## Tips
- you can edit the number of instances to run in prod according to number of cores in scripts/pm2.config.js in production

## Deploy to fly.io with Dockerfile
1. Register/Invite on fly.io
2. Install flyctl cli
3. Run `flyctl auth login`
4. Go to current directory
5. Run `flyctl deploy`

