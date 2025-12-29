alter table executions
  add column if not exists input_decimals integer,
  add column if not exists output_decimals integer;
