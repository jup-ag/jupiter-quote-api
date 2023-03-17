import { Jupiter } from "@jup-ag/core";
import { TokenInfo } from "@solana/spl-token-registry";
import { AccountInfo, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import { FastifyReply, FastifyRequest } from "fastify";
import JSBI from "jsbi";
import { redis } from "../utils/redis";

import TokenInfoResolver from "./utils/getTokenInfoFromSymbol";

export interface PriceRouteQueryString {
  Querystring: {
    ids: string;
    vsToken: string;
    vsAmount: number;
  };
}

interface Store {
  contextSlot: number;
  accountInfos: Map<string, AccountInfo<Buffer>>;
  tokenInfoResolver: TokenInfoResolver;
}

interface IPriceRoute {
  input: string;
  output: string;
  amount: number;
}

interface IResponse {
  inputTokenInfo: TokenInfo;
  ouptutTokenInfo: TokenInfo;
  outputAmount: string;
  price: number;
}

const getCacheKey = (
  inputTokenAddress: string,
  vsTokenAddress: string,
  amount: number | string
): `${string}-${string}` => {
  return `${inputTokenAddress}-${vsTokenAddress}-${amount}`;
};

// Redis, Cache-Control uses seconds, not ms
const CACHE_TIME = 120;

let backgroundTasksTracker: Set<string> = new Set();

const getTokenAndPrice =
  (store: Store, jupiter: Jupiter) =>
  async ({ input, output, amount }: IPriceRoute) => {
    const inputMintInfo = store.tokenInfoResolver.get(input);
    const outputMintInfo = store.tokenInfoResolver.get(output);

    if (!inputMintInfo || !outputMintInfo) {
      throw { code: 404, error: `inputMint or outputMint not found` };
    } else if (Array.isArray(inputMintInfo)) {
      throw {
        code: 409,
        error: `Duplicated symbol found for ${input}, use one of the addresses instead`,
        addresses: inputMintInfo.map(({ address }) => address),
      };
    } else if (Array.isArray(outputMintInfo)) {
      throw {
        code: 409,
        error: `Duplicated symbol found for ${output}, use one of the addresses instead`,
        addresses: outputMintInfo.map(({ address }) => address),
      };
    }

    // Assign a default input amount
    let inputAmount = new Decimal(amount);
    // req.query.amount is already a number, just sanity check
    if (inputAmount.lessThanOrEqualTo(0) || inputAmount.isNaN()) {
      throw { code: 400, error: `Amount must be greater than 0` };
    }

    inputAmount = inputAmount.mul(10 ** inputMintInfo.decimals).floor();

    // Check cache
    const cacheKey = getCacheKey(
      inputMintInfo.address,
      outputMintInfo.address,
      inputAmount.toNumber()
    );

    const computeResult = async () => {
      const { routesInfos: routes } = await jupiter.computeRoutes({
        inputMint: new PublicKey(inputMintInfo.address),
        outputMint: new PublicKey(outputMintInfo.address),
        amount: JSBI.BigInt(inputAmount.toString()),
        slippageBps: 0,
        feeBps: undefined,
        filterTopNResult: 1,
      });

      const topRoute = (routes || [])[0];

      if (!topRoute) {
        throw { code: 400, error: `No routes found` };
      }

      const inputPrice = new Decimal(topRoute.inAmount.toString()).div(
        10 ** inputMintInfo.decimals
      );
      const outputPrice = new Decimal(topRoute.outAmount.toString()).div(
        10 ** outputMintInfo.decimals
      );

      const price = inputPrice.div(outputPrice);

      // Use the higher decimals for the price
      const priceDecimal = Math.max(
        inputMintInfo.decimals,
        outputMintInfo.decimals
      );

      // show higher precision for small values
      const usePrecision = price.lessThan(0.01);

      const result: IResponse = {
        inputTokenInfo: inputMintInfo,
        ouptutTokenInfo: outputMintInfo,
        outputAmount: outputPrice.toString(),
        price: usePrecision
          ? Number(price.toPrecision(Math.max(priceDecimal, 1)))
          : price.toDP(priceDecimal).toNumber(),
      };

      if (Number.isNaN(result.price)) {
        throw { code: 400, error: "Unable to calculate price" };
      }

      // Cache the result
      redis.set(cacheKey, JSON.stringify(result, null, 2), "EX", CACHE_TIME);

      return result;
    };

    const redisResults =
      (await redis
        .pipeline()
        .get(cacheKey)
        .ttl(cacheKey)
        .exec()
        .catch((e) => console.log(e))) || [];

    let [[_, cacheResult], [__, ttl]] = redisResults;
    const found = cacheResult as string | null;

    if (found) {
      if ((ttl as number) < CACHE_TIME / 2) {
        setTimeout(async () => {
          const prefix = "update-";
          // we try to limit the number of background workers
          if (
            backgroundTasksTracker.has(cacheKey) ||
            backgroundTasksTracker.size > 10
          ) {
            return;
          }
          let isUpdating = await redis.get(prefix + cacheKey);

          if (isUpdating) {
            return;
          }

          try {
            await redis.set(prefix + cacheKey, "true", "EX", CACHE_TIME);

            backgroundTasksTracker.add(cacheKey);
            await computeResult();
            await redis.del(prefix + cacheKey);
          } finally {
            backgroundTasksTracker.delete(cacheKey);
          }
        }, 1);
      }
      return JSON.parse(found);
    }

    return await computeResult();
  };

const getTokenAndPriceArray =
  (store: Store, jupiter: Jupiter) =>
  async ({
    id,
    vsToken,
    vsAmount,
  }: {
    id: string;
    vsToken: string;
    vsAmount: number;
  }) => {
    const query: IPriceRoute = (() => {
      if (vsToken && vsAmount)
        return {
          input: vsToken,
          output: id,
          amount: vsAmount,
        };

      if (vsToken)
        return {
          input: vsToken,
          output: id,
          amount: 1,
        };

      // Only amount, vsToken use USDC
      if (vsAmount) {
        return {
          input: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
          output: id,
          amount: vsAmount,
        };
      }

      // Only id is supplied
      // We reverse the input, to make sure it is always quoted with 1 USDC worth of token
      return {
        input: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        output: id,
        amount: 1,
      };
    })();

    let result = await getTokenAndPrice(store, jupiter)(query);

    if (!result) throw { code: 400, error: `No routes found` };

    return result;
  };

const MAX_QUERY_ITEM = 100;
const priceRouteRouter =
  (store: Store, jupiter: Jupiter) =>
  async (req: FastifyRequest<PriceRouteQueryString>, reply: FastifyReply) => {
    // Cache headers, max age 1 minutes
    // reply.header('cache-control', `public, max-age=${CACHE_TIME}`);

    const { ids, vsToken, vsAmount } = req.query;

    // Temporarily disable amount, so our price endpoint is even simpler
    try {
      const now = process.uptime();

      const idArray = ids.split(",").map((item) => item.replaceAll(" ", ""));
      if (idArray.length > MAX_QUERY_ITEM)
        throw {
          code: 400,
          error: `Too many ids, only up to ${MAX_QUERY_ITEM} supported.`,
        };
      const uniqueIds = [...new Set(idArray)];

      const resultPromise = uniqueIds.map((id) =>
        getTokenAndPriceArray(store, jupiter)({ id, vsToken, vsAmount })
      );
      const result = (await Promise.allSettled(resultPromise)).reduce(
        (hash, resp, idx) => {
          const id = uniqueIds[idx];

          if (resp.status === "rejected") {
            // if error found, we dont return in the hash
            // hash[id] = resp.reason;
            return hash;
          }

          const { address: inputAddress, symbol: inputSymbol } =
            resp.value.inputTokenInfo;
          const { address: outputAddress, symbol: outputSymbol } =
            resp.value.ouptutTokenInfo;

          hash[id] = {
            id: outputAddress,
            mintSymbol: outputSymbol,
            vsToken: inputAddress,
            vsTokenSymbol: inputSymbol,
            price: resp.value.price,
          };
          return hash;
        },
        <Record<string, Record<string, any>>>{}
      );
      const timeTaken = process.uptime() - now;
      return { data: result, timeTaken, contextSlot: store.contextSlot };
    } catch (e: any) {
      // Intentional any for TS because we have our own error handling
      if (e && e.code) {
        const { code, ...rest } = e;
        reply.code(code).send(JSON.stringify(rest));
      } else {
        reply.code(500).send(JSON.stringify({ error: e.message }));
      }
    }
  };

export default priceRouteRouter;
