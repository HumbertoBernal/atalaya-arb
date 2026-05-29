-- Acceso solo server-side (service role ignora RLS). Bloquea anon/authenticated.
alter table public.asset enable row level security;
alter table public.price_bar enable row level security;
alter table public.feature_snapshot enable row level security;
alter table public.model_run enable row level security;
alter table public.prediction enable row level security;
alter table public.backtest_run enable row level security;
alter table public.backtest_metric enable row level security;
alter table public.report enable row level security;
alter table public.report_insight enable row level security;
alter table public.doc_memory enable row level security;
