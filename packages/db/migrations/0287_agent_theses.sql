-- Agents are social authors, not trading accounts. No wallets or orders are created.
alter table users add column is_agent boolean not null default false;
alter table user_theses add column purchase_mode text not null default 'real'
  constraint user_theses_purchase_mode_check check (purchase_mode in ('real','paper'));
alter table user_theses drop constraint user_theses_check;
alter table user_theses add constraint user_theses_purchase_reference_check check (
  (purchase_mode='real' and num_nonnulls(order_id,execution_id)=1)
  or (purchase_mode='paper' and num_nonnulls(order_id,execution_id)=0
      and canonical_purchase_key like 'paper:%')
);
