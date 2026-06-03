alter table solana_sponsorship_ledger
  drop constraint if exists solana_sponsorship_ledger_rent_status_check;

alter table solana_sponsorship_ledger
  add constraint solana_sponsorship_ledger_rent_status_check
  check (
    rent_status in (
      'unknown',
      'locked',
      'returned',
      'lost',
      'partially_reclaimed'
    )
  );

update solana_sponsorship_ledger
set
  updated_at = now(),
  rent_status = case
    when coalesce(
      case
        when metadata #>> '{sponsorshipRentReclaim,remainingSponsorLossLamports}' ~ '^[0-9]+$'
          then (metadata #>> '{sponsorshipRentReclaim,remainingSponsorLossLamports}')::numeric
        else null
      end,
      case
        when metadata #>> '{sponsorshipRentReclaim,remainingOpenLamports}' ~ '^[0-9]+$'
          then (metadata #>> '{sponsorshipRentReclaim,remainingOpenLamports}')::numeric
        else null
      end,
      rent_lamports,
      1
    ) <= 0
      then 'returned'
    else 'partially_reclaimed'
  end
where rent_status = 'lost'
  and metadata #>> '{sponsorshipRentReclaim,reclaimedLamports}' ~ '^[0-9]+$'
  and (metadata #>> '{sponsorshipRentReclaim,reclaimedLamports}')::numeric > 0;
