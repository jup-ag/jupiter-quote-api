import { Commitment, Connection } from "@solana/web3.js";
import fetchRetry from "fetch-retry";
import fetch from "cross-fetch";

export const commitment: Commitment = "processed";

const fetchWithRetry = fetchRetry(fetch, {
  retries: 3,
  retryDelay: 100,
}) as any; // minor type mismatch but it's the the same because web3.js specify node-fetch version instead of the standard fetch

// You would need a good rpc
const rpcUrl = process.env.RPC_URL || "";

if (!rpcUrl) {
  throw new Error("RPC_URL is not set");
}

const createConnection = () =>
  new Connection(rpcUrl, {
    commitment,
    fetch: fetchWithRetry,
  });

export let connection = createConnection();
