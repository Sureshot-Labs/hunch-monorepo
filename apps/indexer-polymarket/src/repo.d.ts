export declare function getVenueId(name: string): Promise<number>;
export declare function upsertEvent(row: any): Promise<string>;
export declare function upsertMarket(row: any): Promise<{
    id: string;
    clob_token_yes: string | null;
    clob_token_no: string | null;
}>;
export declare function upsertToken(token: {
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
}): Promise<void>;
export declare function writeBookTop(tokenId: string, bestBid: number | null, bestAsk: number | null, ts: Date): Promise<void>;
//# sourceMappingURL=repo.d.ts.map