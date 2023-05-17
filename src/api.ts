import fastify from "fastify";
import {
  Jupiter,
  MarketInfo,
  RouteInfo,
  SplitTradeAmm,
  SwapMode,
  TransactionFeeInfo,
  routeMapToIndexedRouteMap,
} from "@jup-ag/core";
import {
  AccountInfo,
  PublicKey,
  Transaction,
  TransactionMessage,
} from "@solana/web3.js";
import Swagger from "@fastify/swagger";
import { isMainThread, Worker } from "worker_threads";
import cors from "@fastify/cors";
import { connection } from "./utils/connection";
import { runGetAccountInfosProcess } from "./getAccountInfosProcess";
import type { Amm } from "@jup-ag/core/dist/lib/amm";
import { OpenAPIV3 } from "openapi-types";
import { createPaymentInstruction } from "./utils/payment";
import JSBI from "jsbi";
import { BN } from "bn.js";
import metricsPlugin from "fastify-metrics";
import { MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from "./utils/slippage";
import { MAX_SAFE_U64 } from "./utils/u64";
import sensible from "@fastify/sensible";
import { ammsToExclude } from "./ammsToExclude";

const IS_DEV = process.env.IS_DEV;

const server = fastify({
  logger: false,
  requestTimeout: 5000,
  keepAliveTimeout: 10000,
});

const MarketInfo: OpenAPIV3.SchemaObject = {
  type: "object",
  required: [],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    inputMint: { type: "string" },
    outputMint: { type: "string" },
    notEnoughLiquidity: { type: "boolean" },
    inAmount: { type: "string" },
    outAmount: { type: "string" },
    minInAmount: { type: "string", nullable: true },
    minOutAmount: { type: "string", nullable: true },
    priceImpactPct: { type: "number" },
    lpFee: {
      type: "object",
      properties: {
        amount: { type: "string" },
        mint: { type: "string" },
        pct: { type: "number" },
      },
    },
    platformFee: {
      type: "object",
      properties: {
        amount: { type: "string" },
        mint: { type: "string" },
        pct: { type: "number" },
      },
    },
  },
};

const Route: OpenAPIV3.SchemaObject = {
  type: "object",
  required: [
    "inAmount",
    "outAmount",
    "amount",
    "slippageBps",
    "priceImpactPct",
    "marketInfos",
    "otherAmountThreshold",
    "swapMode",
  ],
  properties: {
    inAmount: { type: "string" },
    outAmount: { type: "string" },
    priceImpactPct: { type: "number" },
    marketInfos: {
      type: "array",
      items: MarketInfo,
    },
    amount: { type: "string" },
    slippageBps: {
      type: "integer",
      minimum: MIN_SLIPPAGE_BPS,
      maximum: MAX_SLIPPAGE_BPS,
    },
    otherAmountThreshold: {
      type: "string",
      description:
        "The threshold for the swap based on the provided slippage: when swapMode is ExactIn the minimum out amount, when swapMode is ExactOut the maximum in amount",
    },
    swapMode: { type: "string", enum: ["ExactIn", "ExactOut"] },
    fees: {
      description: "Only returned when userPublicKey is given to /quote",
      nullable: true,
      type: "object",
      properties: {
        signatureFee: {
          type: "number",
          description:
            "This inidicate the total amount needed for signing transaction(s). Value in lamports.",
        },
        openOrdersDeposits: {
          description:
            "This inidicate the total amount needed for deposit of serum order account(s). Value in lamports.",
          type: "array",
          items: {
            type: "number",
          },
        },
        ataDeposits: {
          description:
            "This inidicate the total amount needed for deposit of associative token account(s). Value in lamports.",
          type: "array",
          items: {
            type: "number",
          },
        },
        totalFeeAndDeposits: {
          type: "number",
          description:
            "This inidicate the total lamports needed for fees and deposits above.",
        },
        minimumSOLForTransaction: {
          type: "number",
          description:
            "This inidicate the minimum lamports needed for transaction(s). Might be used to create wrapped SOL and will be returned when the wrapped SOL is closed.",
        },
      },
    },
  },
};

const Price: OpenAPIV3.SchemaObject = {
  type: "object",
  properties: {
    id: { type: "string", description: "Address of the token" },
    mintSymbol: { type: "string", description: "Symbol of the token" },
    vsToken: { type: "string", description: "Address of the vs token" },
    vsTokenSymbol: { type: "string", description: "Symbol of the vs token" },
    price: {
      type: "number",
      description:
        "Default to 1 unit of the token worth in USDC if vsToken is not specified.",
    },
  },
  example: {
    id: "So11111111111111111111111111111111111111112",
    mintSymbol: "SOL",
    vsToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    vsTokenSymbol: "USDC",
    price: 36.094229038,
  },
};

const PriceHash: OpenAPIV3.SchemaObject = {
  type: "object",
  additionalProperties: {
    $ref: "Price#",
  },
  example: {
    SOL: {
      id: "So11111111111111111111111111111111111111112",
      mintSymbol: "SOL",
      vsToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      vsTokenSymbol: "USDC",
      price: 36.094229038,
    },
    USDT: {
      id: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      mintSymbol: "USDT",
      vsToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      vsTokenSymbol: "USDC",
      price: 1.000052,
    },
  },
};

server.addSchema({
  $id: "MarketInfo",
  ...MarketInfo,
});

server.addSchema({
  $id: "Route",
  ...Route,
});

server.addSchema({
  $id: "Price",
  ...Price,
});

server.addSchema({
  $id: "PriceHash",
  ...PriceHash,
});

const mockGetDepositFee = () => Promise.resolve(undefined);

async function start() {
  let startTime = process.uptime();

  await server.register(sensible);
  await server.register(metricsPlugin, { endpoint: "/metrics" });

  await server.register(cors, {
    origin: "*",
    // a day
    maxAge: 86400000,
    methods: ["GET", "POST"],
  });

  await server.register(Swagger, {
    routePrefix: "/v4/docs",
    swagger: {
      schemes: [process.env.NODE_ENV === "development" ? "http" : "https"],
      info: {
        title: "Jupiter API",
        description: "Jupiter quote and swap API",
        version: "0.0.0",
      },
      consumes: ["application/json"],
      produces: ["application/json"],
    },
    uiConfig: {
      docExpansion: "full",
      deepLinking: false,
      defaultModelRendering: "model",
    },
    staticCSP: false,
    exposeRoute: true,
  });

  server.addHook("onError", async (req, reply, err) => {
    // dont log validation error
    if (!err.validation && err.statusCode !== 429) {
      // log errors
      console.error(err);
    }
  });

  const jupiter = await Jupiter.load({
    connection: connection,
    cluster: "mainnet-beta",
    routeCacheDuration: IS_DEV ? 5_000 : -1,
    restrictIntermediateTokens: true,
    ammsToExclude,
    usePreloadedAddressLookupTableCache: true,
  });

  const accountToAmmIdsMap = jupiter.getAccountToAmmIdsMap();
  const ammIdToAmmMap = jupiter.getAmmIdToAmmMap();

  const routeMap = jupiter.getRouteMap();
  const directRouteMapOnly = jupiter.getRouteMap(true);
  let blockhashWithExpiryBlockHeight = await connection.getLatestBlockhash(
    "confirmed"
  );

  // each blockhash can last about 1 minute, we refresh every second
  setInterval(async () => {
    blockhashWithExpiryBlockHeight = await connection.getLatestBlockhash(
      "confirmed"
    );
  }, 1000);

  const store = {
    contextSlot: 0,
    accountInfos: new Map<string, AccountInfo<Buffer>>(),
  };

  const worker = new Worker(__filename);

  worker.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });

  worker.on("exit", () => {
    console.log("worker exited");
    process.exit(1);
  });

  // wait until the worker is ready`
  let resolved = false;
  await new Promise<void>((resolve) => {
    if (IS_DEV) resolve(); // The fetcher does not run in local dev mode
    worker.on(
      "message",
      ({
        type,
        contextSlot,
        accountInfosMap,
      }: {
        type: string;
        contextSlot: number;
        accountInfosMap: Map<string, AccountInfo<Buffer>>;
      }) => {
        store.contextSlot = contextSlot;

        // We are only updating the contextSlot.
        if (type === "contextSlot") {
          return;
        }

        const ammsIdsToUpdate = new Set<string>();

        accountInfosMap.forEach((value, key) => {
          const ammIds = accountToAmmIdsMap.get(key);
          ammIds?.forEach((ammId) => {
            ammsIdsToUpdate.add(ammId);
          });

          const accountInfo = store.accountInfos.get(key);

          // Hack to turn back the Uint8Array into a buffer so nothing unexpected occurs downstream
          const newData = Buffer.from(value.data);

          if (accountInfo) {
            accountInfo.data = newData;
            store.accountInfos.set(key, accountInfo);
          } else {
            value.data = newData;
            value.owner = new PublicKey(value.owner);
            store.accountInfos.set(key, value);
          }
        });

        // For most amms we would receive multiple accounts at once, we should update only once
        ammsIdsToUpdate.forEach((ammId) => {
          const amm = ammIdToAmmMap.get(ammId);

          if (amm) {
            try {
              amm.update(store.accountInfos);
            } catch (e) {
              console.error(`Failed to update amm ${amm.id}, reason ${e}`);
            }
            if (amm.hasDynamicAccounts) {
              amm.getAccountsForUpdate().forEach((pk) => {
                const account = pk.toString();
                const ammIds = accountToAmmIdsMap.get(account) || new Set();
                ammIds.add(amm.id);
                accountToAmmIdsMap.set(account, ammIds);
              });
            }
          }
        });

        if (!resolved) {
          resolve();
        }
      }
    );
  });

  const [externalDirectIndexedRouteMap, externalIndexedRouteMap] = [
    directRouteMapOnly,
    routeMap,
  ].map(routeMapToIndexedRouteMap);

  interface IQuerystring {
    inputMint: string;
    outputMint: string;
    amount: string;
    swapMode: string;
    slippageBps: string;
    feeBps?: string;
    onlyDirectRoutes?: boolean;
    userPublicKey?: string;
    asLegacyTransaction?: boolean;
  }

  server.register(
    (instance, _opts, next) => {
      const GetQuoteQueryString: OpenAPIV3.SchemaObject = {
        type: "object",
        required: ["inputMint", "outputMint", "amount"],
        properties: {
          inputMint: {
            type: "string",
            description: "inputMint",
          },
          outputMint: {
            type: "string",
            description: "outputMint",
          },
          amount: {
            type: "string",
            description: "amount",
          },
          swapMode: {
            type: "string",
            enum: ["ExactIn", "ExactOut"],
            description: "Swap mode, default is ExactIn",
          },
          slippageBps: {
            type: "integer",
            description: "Slippage bps",
            minimum: MIN_SLIPPAGE_BPS,
            maximum: MAX_SLIPPAGE_BPS,
          },
          feeBps: {
            type: "integer",
            description:
              "Fee BPS (only pass in if you want to charge a fee on this swap)",
          },
          onlyDirectRoutes: {
            type: "boolean",
            description:
              "Only return direct routes (no hoppings and split trade)",
          },
          userPublicKey: {
            type: "string",
            description:
              "Public key of the user (only pass in if you want deposit and fee being returned, might slow down query)",
          },
          asLegacyTransaction: {
            type: "boolean",
            description:
              "Only return routes that can be done in a single legacy transaction. (Routes might be limited)",
          },
        },
      };
      instance.get<{ Querystring: IQuerystring }>(
        "/quote",
        {
          schema: {
            description:
              "Get quote for a given input mint, output mint and amount",
            tags: [],
            summary: "Return route",
            querystring: GetQuoteQueryString,
            response: {
              200: {
                description: "Default response",
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: Route,
                  },
                  timeTaken: { type: "number" },
                  contextSlot: { type: "integer" },
                },
              },
            },
          },
        },
        async (req, reply) => {
          const {
            amount,
            swapMode,
            inputMint,
            outputMint,
            slippageBps,
            feeBps,
            onlyDirectRoutes,
            userPublicKey,
            asLegacyTransaction,
          } = req.query;
          try {
            const now = process.uptime();
            const amountJSBI = JSBI.BigInt(amount);

            if (JSBI.greaterThan(amountJSBI, MAX_SAFE_U64)) {
              reply.badRequest(
                `Amount is too large, max is ${MAX_SAFE_U64.toString()}`
              );
              return;
            }

            const { routesInfos: routes } = await jupiter.computeRoutes({
              inputMint: new PublicKey(inputMint),
              outputMint: new PublicKey(outputMint),
              amount: JSBI.BigInt(amount),
              slippageBps: Math.floor(Number(slippageBps ?? 5)),
              feeBps: Number(feeBps) || undefined,
              onlyDirectRoutes,
              swapMode: swapMode as unknown as SwapMode, // TODO: Validate this at runtime properly
              filterTopNResult: asLegacyTransaction ? 2 : 1,
              asLegacyTransaction,
            });
            const timeTaken = process.uptime() - now;

            const routesToReturn = (routes || []).slice(
              0,
              IS_DEV ? undefined : 3
            );

            let fees: TransactionFeeInfo[] = [];
            if (userPublicKey) {
              fees = await Promise.all(
                routesToReturn.map(async ({ marketInfos }) => {
                  return jupiter.getDepositAndFees({
                    marketInfos: marketInfos,
                    userPublicKey: new PublicKey(userPublicKey),
                  });
                })
              );
            }

            return {
              data: routesToReturn.map(
                (
                  {
                    inAmount,
                    outAmount,
                    marketInfos,
                    amount,
                    otherAmountThreshold,
                    swapMode,
                    priceImpactPct,
                    slippageBps,
                  },
                  idx
                ) => ({
                  inAmount: inAmount.toString(),
                  outAmount: outAmount.toString(),
                  amount: amount.toString(),
                  otherAmountThreshold: otherAmountThreshold.toString(),
                  swapMode,
                  priceImpactPct,
                  slippageBps,
                  marketInfos: marketInfos.map(
                    ({
                      amm,
                      inputMint,
                      outputMint,
                      inAmount,
                      outAmount,
                      lpFee,
                      platformFee,
                      minInAmount,
                      minOutAmount,
                      ...info
                    }) => ({
                      id: amm.id,
                      label: amm.label,
                      inputMint: inputMint.toString(),
                      outputMint: outputMint.toString(),
                      inAmount: inAmount.toString(),
                      outAmount: outAmount.toString(),
                      ...(minInAmount &&
                        minOutAmount && {
                          minInAmount: minInAmount.toString(),
                          minOutAmount: minOutAmount.toString(),
                        }),
                      lpFee: {
                        ...lpFee,
                        amount: lpFee.amount.toString(),
                      },
                      platformFee: {
                        ...platformFee,
                        amount: platformFee.amount.toString(),
                      },
                      ...info,
                    })
                  ),
                  fees: fees[idx],
                })
              ),
              timeTaken,
              contextSlot: store.contextSlot,
            };
          } catch (e: any) {
            console.error(e);
            throw e;
          }
        }
      );

      type SwapBody = {
        userPublicKey: string;
        feeAccount?: string;
        wrapUnwrapSOL?: boolean;
        asLegacyTransaction?: boolean;
        computeUnitPriceMicroLamports?: number;
        route: Omit<
          RouteInfo,
          | "getDepositAndFee"
          | "marketInfos"
          | "inAmount"
          | "outAmount"
          | "amount"
          | "otherAmountThreshold"
        > & {
          marketInfos: Array<
            {
              id: string;
              label: string;
              inputMint: string;
              outputMint: string;
              inAmount: number;
              outAmount: number;
            } & Omit<
              MarketInfo,
              | "amm"
              | "outputMint"
              | "inputMint"
              | "inAmount"
              | "outAmount"
              | "otherAmountThreshold"
            >
          >;
        } & {
          otherAmountThreshold: number;
          inAmount: number;
          outAmount: number;
          amount: number;
        };
        destinationWallet: string;
      };

      const SwapBody: OpenAPIV3.SchemaObject = {
        type: "object",
        required: ["route", "userPublicKey"],
        properties: {
          route: {
            $ref: "Route#",
          },
          userPublicKey: {
            type: "string",
            description: "Public key of the user",
          },
          wrapUnwrapSOL: {
            type: "boolean",
            nullable: true,
            description: "Wrap/unwrap SOL",
          },
          feeAccount: {
            type: "string",
            description:
              "Fee token account for the output token (only pass in if you set a feeBps)",
          },
          asLegacyTransaction: {
            type: "boolean",
            nullable: true,
            description:
              "Request a legacy transaction rather than the default versioned transaction, needs to be paired with a quote using asLegacyTransaction otherwise the transaction might be too large",
          },
          computeUnitPriceMicroLamports: {
            type: "number",
            nullable: true,
            description:
              "compute unit price to prioritize the transaction, the additional fee will be compute unit consumed * computeUnitPriceMicroLamports",
          },
          destinationWallet: {
            type: "string",
            description:
              "Public key of the wallet that will receive the output of the swap, this assumes the associated token account exists, currently adds a token transfer",
          },
        },
      };

      // input is route
      instance.post<{
        Body: SwapBody;
      }>(
        "/swap",
        {
          schema: {
            description: "Get swap serialized transactions for a route",
            tags: [],
            summary: "Return setup, swap and cleanup transactions",
            body: SwapBody,
            response: {
              200: {
                description: "Default response",
                type: "object",
                properties: {
                  swapTransaction: {
                    type: "string",
                    description: "Base64 encoded transaction",
                  },
                },
              },
            },
          },
        },
        async (req) => {
          let {
            route,
            userPublicKey,
            feeAccount,
            wrapUnwrapSOL,
            asLegacyTransaction,
            computeUnitPriceMicroLamports,
            destinationWallet,
          } = req.body;
          try {
            const user = new PublicKey(userPublicKey);

            const swapMode = route.swapMode || SwapMode.ExactIn;

            const { swapTransaction, addressLookupTableAccounts } =
              await jupiter.exchange({
                userPublicKey: user,
                feeAccount: feeAccount ? new PublicKey(feeAccount) : undefined,
                wrapUnwrapSOL,
                computeUnitPriceMicroLamports,
                blockhashWithExpiryBlockHeight,
                asLegacyTransaction,
                routeInfo: {
                  ...route,
                  swapMode,
                  inAmount: JSBI.BigInt(route.inAmount),
                  outAmount: JSBI.BigInt(route.outAmount),
                  amount: JSBI.BigInt(route.amount),
                  otherAmountThreshold: JSBI.BigInt(
                    route.otherAmountThreshold ?? 0
                  ),
                  getDepositAndFee: mockGetDepositFee,
                  marketInfos: route.marketInfos.map(
                    (marketInfo, _, marketInfos) => ({
                      ...marketInfo,
                      inputMint: new PublicKey(marketInfo.inputMint),
                      outputMint: new PublicKey(marketInfo.outputMint),
                      inAmount: JSBI.BigInt(marketInfo.inAmount),
                      outAmount: JSBI.BigInt(marketInfo.outAmount),
                      amm: (() => {
                        let amm: Amm | undefined = ammIdToAmmMap.get(
                          marketInfo.id
                        );

                        // might be split trade amm if there's only one amm
                        if (!amm && marketInfos.length === 1) {
                          const ammIds =
                            SplitTradeAmm.getAmmIdsFromSplitTradeAmmId(
                              marketInfo.id
                            );

                          if (ammIds.length) {
                            const amms = ammIds.map((id) => {
                              const amm = ammIdToAmmMap.get(id);
                              if (!amm) {
                                throw new Error("Amm not found");
                              }
                              return amm;
                            });

                            const integerMatches = Array.from(
                              route.marketInfos[0].label.matchAll(/\((\d+)%\)/g)
                            ).map((item) => item[1]);

                            const splitTradeAmm = SplitTradeAmm.create(
                              amms[0],
                              amms[1]
                            );

                            if (!splitTradeAmm) {
                              throw new Error(
                                "Invalid Split Trade combination"
                              );
                            }

                            if (integerMatches) {
                              const [portion1, portion2] =
                                integerMatches.map(Number);

                              splitTradeAmm.setPortions(portion1, portion2);
                            } else {
                              throw new Error("Invalid Split Trade label");
                            }
                            amm = splitTradeAmm;
                          }
                        }

                        if (!amm) {
                          throw new Error("Amm not found");
                        }

                        return amm;
                      })(),
                    })
                  ),
                },
              });

            if (destinationWallet) {
              if (swapMode !== SwapMode.ExactOut)
                throw new Error(
                  "Destination wallet is only available when SwapMode.ExactOut"
                );

              const paymentInstruction = await createPaymentInstruction({
                userPublicKey: user,
                destinationWallet: new PublicKey(destinationWallet),
                outputMint: new PublicKey(
                  route.marketInfos[route.marketInfos.length - 1].outputMint
                ),
                paymentAmount: new BN(route.amount),
              });
              if (swapTransaction instanceof Transaction) {
                swapTransaction.instructions.push(paymentInstruction);
              } else {
                const message = TransactionMessage.decompile(
                  swapTransaction.message,
                  {
                    addressLookupTableAccounts,
                  }
                );
                message.instructions.push(paymentInstruction);
                swapTransaction.message = message.compileToV0Message(
                  addressLookupTableAccounts
                );
              }
            }

            return {
              swapTransaction: Buffer.from(
                swapTransaction.serialize({
                  requireAllSignatures: false,
                  verifySignatures: false,
                })
              ).toString("base64"),
            };
          } catch (e: any) {
            const error = e as Error;
            error.name += route.marketInfos
              .map(({ id, label }) => `${label}(${id})`)
              .join(", ");
            throw error;
          }
        }
      );

      const GetPriceQueryString: OpenAPIV3.SchemaObject = {
        type: "object",
        properties: {
          ids: {
            type: "string",
            description:
              "Symbol or address of a token, (e.g. SOL or EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). Use `,` to query multiple tokens, e.g. (sol,btc,mer,<address>)",
          },
          vsToken: {
            type: "string",
            description:
              "Default to USDC. Symbol or address of a token, (e.g. SOL or EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).",
          },
          vsAmount: {
            type: "number",
            description: "Unit amount of specified input token. Default to 1.",
          },
        },
        required: ["ids"],
      };

      instance.get<{
        Querystring: { onlyDirectRoutes?: boolean };
      }>(
        "/indexed-route-map",
        {
          schema: {
            description:
              "Returns a hash map, input mint as key and an array of valid output mint as values, token mints are indexed to reduce the file size",
            querystring: {
              type: "object",
              properties: {
                onlyDirectRoutes: {
                  type: "boolean",
                  description:
                    "Only return direct routes (no hoppings and split trade)",
                },
              },
            },
            response: {
              200: {
                description: "Default response",
                type: "object",
                properties: {
                  mintKeys: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "All the mints that are indexed to match in indexedRouteMap",
                  },
                  indexedRouteMap: {
                    type: "object",
                    description:
                      "All the possible route and their corresponding output mints",
                    additionalProperties: {
                      type: "array",
                      items: { type: "number" },
                    },
                    example: {
                      1: [2, 3, 4],
                      2: [1, 3, 4],
                    },
                  },
                },
              },
            },
          },
        },
        async ({ query: { onlyDirectRoutes } = {}, validationError }, res) => {
          try {
            res.header("cache-control", "public, max-age=60");
            // max age 1 minute
            res.header("max-age", "60");

            if (onlyDirectRoutes) {
              return externalDirectIndexedRouteMap;
            }

            return externalIndexedRouteMap;
          } catch (e: any) {
            throw e;
          }
        }
      );

      next();
    },
    { prefix: "/v4" }
  );

  server.listen(
    {
      port: Number(process.env.PORT || 8080),
      host: "::",
    },
    (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      process.send?.("ready");
      console.log(
        `Server listening at ${address}, started in ${
          process.uptime() - startTime
        }s`
      );
    }
  );

  process.on("SIGINT", async function () {
    server.close();
  });
}

if (isMainThread) {
  start().catch(() => {
    process.exit(1);
  });
} else {
  runGetAccountInfosProcess().catch(() => {
    process.exit(1);
  });
}
