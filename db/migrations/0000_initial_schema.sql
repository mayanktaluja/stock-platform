CREATE TABLE "nse_event_calendar" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticker" varchar(32) NOT NULL,
	"event_date" date NOT NULL,
	"event_type" varchar(32),
	"purpose" text,
	"meta" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sws_companies" (
	"ticker" varchar(32) PRIMARY KEY NOT NULL,
	"name" varchar(256),
	"sector" varchar(96),
	"sws_url" text,
	"sws_company_id" uuid,
	"indices" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sws_company_snapshots" (
	"ticker" varchar(32) NOT NULL,
	"run_id" uuid NOT NULL,
	"name" varchar(256),
	"sector" varchar(96),
	"classification_status" varchar(32),
	"parsed_at" timestamp with time zone,
	"current_price_inr" double precision,
	"market_cap_inr" double precision,
	"market_cap_usd" double precision,
	"market_cap_band" varchar(16),
	"shares_outstanding" double precision,
	"fair_value_inr" double precision,
	"upside_pct" double precision,
	"snowflake_total" integer,
	"snowflake_valuation" integer,
	"snowflake_future_growth" integer,
	"snowflake_past_performance" integer,
	"snowflake_financial_health" integer,
	"snowflake_dividends" integer,
	"pe" double precision,
	"pb" double precision,
	"ps" double precision,
	"ev_ebitda" double precision,
	"returns_1m_pct" double precision,
	"returns_3m_pct" double precision,
	"returns_6m_pct" double precision,
	"returns_1y_pct" double precision,
	"returns_5y_pct" double precision,
	"net_margin_pct" double precision,
	"revenue_growth_pct" double precision,
	"earnings_growth_yoy_pct" double precision,
	"forward_earnings_growth_pct" double precision,
	"latest_revenue" double precision,
	"latest_net_income" double precision,
	"latest_eps" double precision,
	"most_recent_reported_date" date,
	"dividend_yield_pct" double precision,
	"payout_pct" double precision,
	"annualized_dividend" double precision,
	"next_earnings_date" date,
	"recent_news_count" integer,
	"insider_ownership_pct" double precision,
	"last_quarter_result" varchar(16),
	"news" jsonb,
	"top_holders" jsonb,
	"recent_dividend_payments" jsonb,
	"fiscal_yearly_history" jsonb,
	"rewards" jsonb,
	"risks" jsonb,
	"industry_benchmarks" jsonb,
	"insider_activity" jsonb,
	"recent_analyst_revisions" jsonb,
	"raw_extra" jsonb,
	CONSTRAINT "sws_company_snapshots_ticker_run_id_pk" PRIMARY KEY("ticker","run_id")
);
--> statement-breakpoint
CREATE TABLE "sws_control_flags" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb,
	"holder_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sws_picks" (
	"run_id" uuid NOT NULL,
	"ticker" varchar(32) NOT NULL,
	"section" varchar(48) NOT NULL,
	"rank_in_section" integer,
	"name" varchar(256),
	"sector" varchar(96),
	"sws_url" text,
	"score" double precision,
	"v2_score" double precision,
	"v3_score" double precision,
	"v3_score_100" double precision,
	"v3_verdict" varchar(24),
	"verdict" varchar(24),
	"composite_verdict" varchar(24),
	"valuation_band" varchar(24),
	"snowflake_total" integer,
	"current_price_inr" double precision,
	"fair_value_inr" double precision,
	"upside_pct" double precision,
	"market_cap_inr" double precision,
	"last_quarter_result" varchar(16),
	"next_earnings_date" date,
	"snowflake" jsonb,
	"v2_breakdown" jsonb,
	"v3_breakdown" jsonb,
	"audit_trail" jsonb,
	"counter_thesis" text,
	"narrative" jsonb,
	"section_status" jsonb,
	"earnings_beat_meta" jsonb,
	"surveillance" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sws_picks_run_id_ticker_section_pk" PRIMARY KEY("run_id","ticker","section")
);
--> statement-breakpoint
CREATE TABLE "sws_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pipeline" varchar(16) DEFAULT 'api' NOT NULL,
	"status" varchar(24) DEFAULT 'running' NOT NULL,
	"duration_seconds" integer,
	"scored_count" integer,
	"shards_failed" integer,
	"news_items_total" integer,
	"deep_files_scanned" integer,
	"news_populated_count" integer,
	"is_canonical" boolean DEFAULT false NOT NULL,
	"scrape_skipped" boolean DEFAULT false,
	"sections_count" jsonb,
	"per_shard_progress" jsonb
);
--> statement-breakpoint
CREATE TABLE "sws_sanity_reports" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verdict" varchar(16),
	"block_count" integer,
	"warn_count" integer,
	"pass_count" integer,
	"total_checks" integer,
	"layers" jsonb
);
--> statement-breakpoint
CREATE TABLE "sws_scrape_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"ticker" varchar(32) NOT NULL,
	"failed_tab" varchar(32),
	"error" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sws_shard_progress" (
	"shard_id" integer PRIMARY KEY NOT NULL,
	"next_local_index" integer DEFAULT 0,
	"done_count" integer DEFAULT 0,
	"today_count" integer DEFAULT 0,
	"today_date" date,
	"started_at" timestamp with time zone,
	"last_ticker" varchar(32),
	"last_run_at" timestamp with time zone,
	"last_duration_ms" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sws_universe_entries" (
	"run_id" uuid NOT NULL,
	"ticker" varchar(32) NOT NULL,
	"universe_index" integer,
	"name" varchar(256),
	"sector" varchar(96),
	"industry" varchar(96),
	"exchange" varchar(16),
	"sws_short_id" varchar(32),
	"sws_url" text,
	"slug" varchar(256),
	"indices" jsonb,
	"seed_only" boolean,
	"curated" boolean,
	"market_cap_inr" double precision,
	"source" varchar(32),
	CONSTRAINT "sws_universe_entries_run_id_ticker_pk" PRIMARY KEY("run_id","ticker")
);
--> statement-breakpoint
CREATE TABLE "sws_universe_stats" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"universe_size" integer,
	"r1m" jsonb,
	"r3m" jsonb,
	"r1y" jsonb,
	"counts" jsonb
);
--> statement-breakpoint
ALTER TABLE "sws_company_snapshots" ADD CONSTRAINT "sws_company_snapshots_run_id_sws_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sws_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sws_picks" ADD CONSTRAINT "sws_picks_run_id_sws_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sws_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sws_sanity_reports" ADD CONSTRAINT "sws_sanity_reports_run_id_sws_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sws_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sws_scrape_failures" ADD CONSTRAINT "sws_scrape_failures_run_id_sws_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sws_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sws_universe_entries" ADD CONSTRAINT "sws_universe_entries_run_id_sws_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sws_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sws_universe_stats" ADD CONSTRAINT "sws_universe_stats_run_id_sws_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sws_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nse_event_unique_idx" ON "nse_event_calendar" USING btree ("ticker","event_date","event_type");--> statement-breakpoint
CREATE INDEX "nse_event_ticker_date_idx" ON "nse_event_calendar" USING btree ("ticker","event_date");--> statement-breakpoint
CREATE INDEX "sws_snap_run_ticker_idx" ON "sws_company_snapshots" USING btree ("run_id","ticker");--> statement-breakpoint
CREATE INDEX "sws_snap_run_sector_r1m_idx" ON "sws_company_snapshots" USING btree ("run_id","sector","returns_1m_pct");--> statement-breakpoint
CREATE INDEX "sws_picks_run_section_rank_idx" ON "sws_picks" USING btree ("run_id","section","rank_in_section");--> statement-breakpoint
CREATE INDEX "sws_picks_run_ticker_idx" ON "sws_picks" USING btree ("run_id","ticker");--> statement-breakpoint
CREATE UNIQUE INDEX "sws_runs_canonical_unique_idx" ON "sws_runs" USING btree ("is_canonical") WHERE "sws_runs"."is_canonical" = true;--> statement-breakpoint
CREATE INDEX "sws_runs_started_at_idx" ON "sws_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "sws_failures_ticker_recent_idx" ON "sws_scrape_failures" USING btree ("ticker","recorded_at");--> statement-breakpoint
CREATE INDEX "sws_universe_run_sector_idx" ON "sws_universe_entries" USING btree ("run_id","sector");