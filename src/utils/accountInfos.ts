import * as zstd from '@bokuweb/zstd-wasm';
import { AccountInfo } from '@solana/web3.js';

function deserializeAccountInfo(accountInfo: AccountInfo<string[]>): AccountInfo<Buffer> {
  // purposely mutate data, so it's faster
  const data = Buffer.from(zstd.decompress(Buffer.from(accountInfo.data[0], 'base64')));
  return { ...accountInfo, data };
}

export function deserializeAccountInfosMap(
  accountInfosMap: Map<string, AccountInfo<string[]>>,
): Map<string, AccountInfo<Buffer>> {
  const deserializedAccountInfoMap = new Map<string, AccountInfo<Buffer>>();
  accountInfosMap.forEach((value, key) => {
    deserializedAccountInfoMap.set(key, deserializeAccountInfo(value));
  });
  return deserializedAccountInfoMap;
}
