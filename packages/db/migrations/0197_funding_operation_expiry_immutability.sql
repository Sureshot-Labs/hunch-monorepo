create or replace function funding_prevent_operation_expiry_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.expires_at is distinct from old.expires_at then
    raise exception 'funding operation expiry is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_operations_immutable_expiry
before update on funding_operations
for each row execute function funding_prevent_operation_expiry_mutation();
