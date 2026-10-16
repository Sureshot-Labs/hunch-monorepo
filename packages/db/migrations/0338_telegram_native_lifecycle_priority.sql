-- Resource fairness for a batch of one. This is a card traversal preference,
-- never a financial status, authorization, or historical publication cutoff.
alter table telegram_native_lifecycle_scan add column prefer_history boolean not null default true;
