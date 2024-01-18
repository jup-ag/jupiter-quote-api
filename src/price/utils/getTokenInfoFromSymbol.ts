import { TokenInfo } from '@solana/spl-token-registry';
import got from 'got';

// TokenInfoResolver is a self-contained class that loads TokenInfo on init, from cache.jup.ag/tokens
// For convenient usage of token finding from symbol, and duplication detection
export default class TokenInfoResolver {
  public tokenMap: Map<string, TokenInfo> = new Map();
  public verifiedSymbolMap: Map<string, TokenInfo[]> = new Map();
  public allSymbolMap: Map<string, TokenInfo[]> = new Map();

  public get(symbolOrAddress: string) {
    if (!symbolOrAddress) return null;

    const isAddress = symbolOrAddress.length >= 32 && symbolOrAddress.length <= 48;
    if (isAddress) {
      return this.tokenMap.get(symbolOrAddress);
    }

    const found = this.getTokenInfoFromSymbol(symbolOrAddress);
    if (found) return found;
    return null;
  }

  public async init() {
    await this.fetchTokenInfos();
  }

  public static isUnknownToken(tokenInfo: TokenInfo) {
    return tokenInfo.tags?.[0] === 'unknown';
  }

  private async fetchTokenInfos() {
    try {
      const result = await got('https://cache.jup.ag/tokens').json<TokenInfo[]>();
      if (result && result.length > 0) {
        result.forEach((tokenInfo) => {
          this.tokenMap.set(tokenInfo.address, tokenInfo);

          const isUnknown = TokenInfoResolver.isUnknownToken(tokenInfo);
          const tokenSymbol = tokenInfo.symbol;

          if (!isUnknown) {
            const symbolExist = this.verifiedSymbolMap.get(tokenSymbol);
            if (symbolExist) {
              this.verifiedSymbolMap.set(tokenSymbol, [...symbolExist, tokenInfo]);
            } else {
              this.verifiedSymbolMap.set(tokenSymbol, [tokenInfo]);
            }
          }

          const symbolExist = this.allSymbolMap.get(tokenSymbol);
          if (symbolExist) {
            this.allSymbolMap.set(
              tokenSymbol,
              // move unknown tokens to the right
              [...symbolExist, tokenInfo].sort((item) => (TokenInfoResolver.isUnknownToken(item) ? 1 : -1)),
            );
          } else {
            this.allSymbolMap.set(tokenSymbol, [tokenInfo]);
          }
        });
      }
    } catch (error) {
      console.error('Error fetching https://cache.jup.ag/tokens', error);
    }
  }

  public getTokenInfoFromSymbol(symbol: TokenInfo['symbol']) {
    const verifiedTokens = this.verifiedSymbolMap.get(symbol);
    if (verifiedTokens) {
      if (verifiedTokens.length === 1) return verifiedTokens[0]; // Else, return only item
    }

    const allTokens = this.allSymbolMap.get(symbol);
    if (allTokens) {
      if (allTokens.length > 1) return allTokens; // symbolMap have more than 1 item, means there are duplicated symbol
      if (allTokens.length === 1) return allTokens[0]; // Else, return only item
    }

    return null;
  }
}
