/* no-transaction */

set lock_timeout = '5min';
set statement_timeout = 0;

create index concurrently if not exists idx_referrals_referral_code_created_at
  on referrals (referral_code_id, created_at desc, referred_user_id);

reset lock_timeout;
reset statement_timeout;
