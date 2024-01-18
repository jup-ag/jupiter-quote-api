---
We no longer maintain this repo. For the latest API, check out [Jupiter Swap API](https://github.com/jup-ag/jupiter-swap-api).
---

# [Deprecated] Jupiter Quote API

This is the same code that we use to host our Jupiter API on [fly.io](https://fly.io).

## Prerequisite

- [redis](https://redis.io/docs/getting-started/installation/install-redis-on-mac-os/)
- [pm2](https://pm2.io/docs/runtime/guide/installation/)

## How to Run Locally

1. `pnpm install`
2. `RPC_URL=xxxxxxx pnpm start`

## Deploy to fly.io With Dockerfile

1. Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
2. Sign up on fly.io: https://fly.io/docs/hands-on/sign-up/
3. On the project directory: `fly launch`
  * You don't need the Postgresql database
  * You don't need the Redis cache
4. Update the `RPC_URL` to your own RPC in `fly.toml`
5. Then, `fly deploy`
6. You will need a more powerful machine to run the API: `fly scale vm performance-2x`

## Tips
- you can edit the number of instances to run in production according to number of cores in scripts/pm2.config.js.
