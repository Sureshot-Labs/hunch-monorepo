import { Pool } from "pg";
export declare const pool: Pool;
export declare function tx<T>(fn: (c: any) => Promise<T>): Promise<T>;
//# sourceMappingURL=db.d.ts.map