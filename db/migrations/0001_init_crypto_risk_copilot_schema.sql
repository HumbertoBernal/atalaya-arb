-- Esquema base Crypto Risk Copilot (proyecto Supabase coding-challenge-mx)
-- pgvector para memoria documental (explicaciones, FAQ, notas de riesgo)
create extension if not exists vector;

create table if not exists asset (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  source text not null,
  asset_type text not null default 'crypto',
  created_at timestamptz not null default now(),
  unique (symbol, source)
);

create table if not exists price_bar (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references asset(id) on delete cascade,
  ts timestamptz not null,
  open double precision,
  high double precision,
  low double precision,
  close double precision,
  volume double precision,
  unique (asset_id, ts)
);
create index if not exists idx_price_bar_asset_ts on price_bar(asset_id, ts);

create table if not exists feature_snapshot (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references asset(id) on delete cascade,
  ts timestamptz not null,
  features jsonb not null,
  feature_set_version text not null default 'v1'
);
create index if not exists idx_feature_snapshot_asset_ts on feature_snapshot(asset_id, ts);

create table if not exists model_run (
  id uuid primary key default gen_random_uuid(),
  model_name text not null,
  task_type text not null,
  params jsonb not null default '{}',
  train_window text,
  test_window text,
  created_at timestamptz not null default now()
);

create table if not exists prediction (
  id uuid primary key default gen_random_uuid(),
  model_run_id uuid not null references model_run(id) on delete cascade,
  asset_id uuid not null references asset(id) on delete cascade,
  ts timestamptz not null,
  y_pred double precision,
  y_true double precision,
  confidence double precision
);
create index if not exists idx_prediction_run on prediction(model_run_id);

create table if not exists backtest_run (
  id uuid primary key default gen_random_uuid(),
  strategy_name text not null,
  assumptions jsonb not null default '{}',
  fee_bps double precision not null default 0,
  slippage_bps double precision not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists backtest_metric (
  id uuid primary key default gen_random_uuid(),
  backtest_run_id uuid not null references backtest_run(id) on delete cascade,
  metric_name text not null,
  metric_value double precision
);
create index if not exists idx_backtest_metric_run on backtest_metric(backtest_run_id);

create table if not exists report (
  id uuid primary key default gen_random_uuid(),
  report_type text not null,
  created_at timestamptz not null default now()
);

create table if not exists report_insight (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report(id) on delete cascade,
  section_name text not null,
  payload jsonb not null default '{}'
);

-- Memoria documental con embeddings (1536 dims = OpenAI text-embedding-3-small)
create table if not exists doc_memory (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  metadata jsonb not null default '{}',
  embedding vector(1536),
  created_at timestamptz not null default now()
);
