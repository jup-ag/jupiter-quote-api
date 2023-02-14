const path = require("path");

module.exports = [
  {
    name: "fetcher",
    script: path.join(__dirname, "../dist/rpcFetcher.js"),
    instances: 1,
    exec_mode: "fork",
  },
  {
    name: "api",
    exec_mode: "cluster",
    script: path.join(__dirname, "../dist/api.js"),
    wait_ready: false,
    listen_timeout: 5000,
    instances: process.env.IS_DEV ? 1 : 1, // you can set this for number of cores - 1 for production
    env_development: {
      IS_DEV: "true",
    },
  },
];
