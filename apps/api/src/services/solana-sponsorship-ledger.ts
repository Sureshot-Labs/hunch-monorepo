import { pool } from "../db.js";

type SolanaSponsorshipLedgerStatus =
  | "created"
  | "intent_created"
  | "user_signed"
  | "failed"
  | "submitted"
  | "confirmed";

type SolanaSponsorshipLedgerFlow =
  | "dflow"
  | "across"
  | "directTransfer"
  | "debridge";

type SolanaSponsorshipLedgerVenue = "kalshi" | "bridge" | "wallet";

export async function upsertSolanaSponsorshipLedger(inputs: {
  userId: string;
  venue: SolanaSponsorshipLedgerVenue;
  flow: SolanaSponsorshipLedgerFlow;
  status: SolanaSponsorshipLedgerStatus;
  intentId?: string | null;
  walletAddress?: string | null;
  sponsorAddress?: string | null;
  marketId?: string | null;
  inputMint?: string | null;
  outputMint?: string | null;
  amountRaw?: string | null;
  messageDigest?: string | null;
  transactionDigest?: string | null;
  txSignature?: string | null;
  estimatedSponsorLamports?: string | null;
  actualSponsorLamports?: string | null;
  rentLamports?: string | null;
  rentStatus?: "unknown" | "locked" | "returned" | "lost" | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `
      insert into solana_sponsorship_ledger (
        user_id,
        venue,
        flow,
        status,
        intent_id,
        wallet_address,
        sponsor_address,
        market_id,
        input_mint,
        output_mint,
        amount_raw,
        message_digest,
        transaction_digest,
        tx_signature,
        estimated_sponsor_lamports,
        actual_sponsor_lamports,
        rent_lamports,
        rent_status,
        error,
        metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, coalesce($18, 'unknown'), $19, $20
      )
      on conflict (intent_id) where intent_id is not null
      do update set
        updated_at = now(),
        status = case
          when coalesce(
            array_position(
              array['created', 'intent_created', 'user_signed', 'submitted', 'failed', 'confirmed'],
              excluded.status
            ),
            0
          ) >= coalesce(
            array_position(
              array['created', 'intent_created', 'user_signed', 'submitted', 'failed', 'confirmed'],
              solana_sponsorship_ledger.status
            ),
            0
          )
            then excluded.status
          else solana_sponsorship_ledger.status
        end,
        tx_signature = coalesce(excluded.tx_signature, solana_sponsorship_ledger.tx_signature),
        transaction_digest = coalesce(excluded.transaction_digest, solana_sponsorship_ledger.transaction_digest),
        actual_sponsor_lamports = coalesce(
          excluded.actual_sponsor_lamports,
          solana_sponsorship_ledger.actual_sponsor_lamports
        ),
        estimated_sponsor_lamports = greatest(
          solana_sponsorship_ledger.estimated_sponsor_lamports,
          excluded.estimated_sponsor_lamports
        ),
        rent_lamports = coalesce(excluded.rent_lamports, solana_sponsorship_ledger.rent_lamports),
        rent_status = coalesce(excluded.rent_status, solana_sponsorship_ledger.rent_status),
        error = case
          when solana_sponsorship_ledger.status = 'confirmed'
            and excluded.status = 'failed'
            then solana_sponsorship_ledger.error
          else coalesce(excluded.error, solana_sponsorship_ledger.error)
        end,
        metadata = solana_sponsorship_ledger.metadata || excluded.metadata
    `,
    [
      inputs.userId,
      inputs.venue,
      inputs.flow,
      inputs.status,
      inputs.intentId ?? null,
      inputs.walletAddress ?? null,
      inputs.sponsorAddress ?? null,
      inputs.marketId ?? null,
      inputs.inputMint ?? null,
      inputs.outputMint ?? null,
      inputs.amountRaw ?? null,
      inputs.messageDigest ?? null,
      inputs.transactionDigest ?? null,
      inputs.txSignature ?? null,
      inputs.estimatedSponsorLamports ?? "0",
      inputs.actualSponsorLamports ?? null,
      inputs.rentLamports ?? null,
      inputs.rentStatus ?? null,
      inputs.error ?? null,
      JSON.stringify(inputs.metadata ?? {}),
    ],
  );
}
