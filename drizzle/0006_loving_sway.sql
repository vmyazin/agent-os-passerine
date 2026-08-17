ALTER TABLE "workflow_runs" ADD COLUMN "idempotency_fingerprint" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_checked_event"(
	p_run_id text,
	p_event_id text,
	p_fingerprint text,
	p_type text,
	p_payload jsonb
) RETURNS "domain_events"
LANGUAGE plpgsql
AS $$
DECLARE
	stored "domain_events"%ROWTYPE;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended(p_run_id, 0));
	SELECT * INTO stored
	FROM "domain_events"
	WHERE "run_id" = p_run_id AND "event_id" = p_event_id;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	IF stored."fingerprint" <> p_fingerprint
		OR stored."type" <> p_type
		OR stored."payload" IS DISTINCT FROM p_payload THEN
		RAISE EXCEPTION 'agentos_event_conflict' USING ERRCODE = 'P0001';
	END IF;
	RETURN stored;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_append_event"(
	p_run_id text,
	p_event_id text,
	p_fingerprint text,
	p_type text,
	p_payload jsonb,
	p_occurred_at timestamp with time zone
) RETURNS "domain_events"
LANGUAGE plpgsql
AS $$
DECLARE
	stored "domain_events"%ROWTYPE;
	allocated_sequence bigint;
BEGIN
	stored := "agentos_checked_event"(
		p_run_id, p_event_id, p_fingerprint, p_type, p_payload
	);
	IF stored."event_id" IS NOT NULL THEN
		RETURN stored;
	END IF;
	INSERT INTO "run_event_sequences" ("run_id", "next_sequence")
	VALUES (p_run_id, 2)
	ON CONFLICT ("run_id") DO UPDATE
	SET "next_sequence" = "run_event_sequences"."next_sequence" + 1
	RETURNING "next_sequence" - 1 INTO allocated_sequence;
	INSERT INTO "domain_events" (
		"run_id", "event_id", "fingerprint", "sequence", "type", "payload", "occurred_at"
	) VALUES (
		p_run_id, p_event_id, p_fingerprint, allocated_sequence, p_type, p_payload, p_occurred_at
	) RETURNING * INTO stored;
	RETURN stored;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_cancel_run_with_event"(
	p_run_id text,
	p_updated_at timestamp with time zone,
	p_completed_at timestamp with time zone,
	p_event_id text,
	p_fingerprint text,
	p_type text,
	p_payload jsonb,
	p_occurred_at timestamp with time zone
) RETURNS "workflow_runs"
LANGUAGE plpgsql
AS $$
DECLARE
	stored_event "domain_events"%ROWTYPE;
	stored_run "workflow_runs"%ROWTYPE;
BEGIN
	stored_event := "agentos_checked_event"(
		p_run_id, p_event_id, p_fingerprint, p_type, p_payload
	);
	IF stored_event."event_id" IS NOT NULL THEN
		SELECT * INTO STRICT stored_run FROM "workflow_runs" WHERE "id" = p_run_id;
		IF stored_run."status" <> 'cancelled' THEN
			RAISE EXCEPTION 'agentos_event_state_conflict' USING ERRCODE = 'P0001';
		END IF;
		RETURN stored_run;
	END IF;
	UPDATE "workflow_runs"
	SET "status" = 'cancelled', "updated_at" = p_updated_at, "completed_at" = p_completed_at
	WHERE "id" = p_run_id AND "status" NOT IN ('succeeded', 'failed', 'cancelled')
	RETURNING * INTO stored_run;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'agentos_invalid_run_state' USING ERRCODE = 'P0001';
	END IF;
	PERFORM "agentos_append_event"(
		p_run_id, p_event_id, p_fingerprint, p_type, p_payload, p_occurred_at
	);
	RETURN stored_run;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_consume_approval_with_event"(
	p_approval_id text,
	p_run_id text,
	p_scope text,
	p_scope_fingerprint text,
	p_consumed_at timestamp with time zone,
	p_event_id text,
	p_event_fingerprint text,
	p_event_type text,
	p_event_payload jsonb,
	p_occurred_at timestamp with time zone
) RETURNS SETOF "approvals"
LANGUAGE plpgsql
AS $$
DECLARE
	stored_event "domain_events"%ROWTYPE;
	stored_approval "approvals"%ROWTYPE;
BEGIN
	stored_event := "agentos_checked_event"(
		p_run_id, p_event_id, p_event_fingerprint, p_event_type, p_event_payload
	);
	IF stored_event."event_id" IS NOT NULL THEN
		SELECT * INTO stored_approval FROM "approvals"
		WHERE "id" = p_approval_id AND "run_id" = p_run_id;
		IF NOT FOUND OR stored_approval."status" <> 'consumed' THEN
			RAISE EXCEPTION 'agentos_event_state_conflict' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEXT stored_approval;
		RETURN;
	END IF;
	UPDATE "approvals"
	SET "status" = 'consumed', "consumed_at" = p_consumed_at
	WHERE "id" = p_approval_id AND "run_id" = p_run_id
		AND "scope" = p_scope AND "fingerprint" = p_scope_fingerprint
		AND "status" = 'pending' AND "expires_at" > p_consumed_at
	RETURNING * INTO stored_approval;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	PERFORM "agentos_append_event"(
		p_run_id, p_event_id, p_event_fingerprint, p_event_type, p_event_payload, p_occurred_at
	);
	RETURN NEXT stored_approval;
	RETURN;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_reply_inbox_with_event"(
	p_message_id text,
	p_run_id text,
	p_reply jsonb,
	p_replied_at timestamp with time zone,
	p_event_id text,
	p_event_fingerprint text,
	p_event_type text,
	p_event_payload jsonb,
	p_occurred_at timestamp with time zone
) RETURNS "inbox_messages"
LANGUAGE plpgsql
AS $$
DECLARE
	stored_event "domain_events"%ROWTYPE;
	stored_message "inbox_messages"%ROWTYPE;
BEGIN
	stored_event := "agentos_checked_event"(
		p_run_id, p_event_id, p_event_fingerprint, p_event_type, p_event_payload
	);
	IF stored_event."event_id" IS NOT NULL THEN
		SELECT * INTO stored_message FROM "inbox_messages"
		WHERE "id" = p_message_id AND "run_id" = p_run_id;
		IF NOT FOUND OR stored_message."status" <> 'replied'
			OR stored_message."reply" IS DISTINCT FROM p_reply THEN
			RAISE EXCEPTION 'agentos_event_state_conflict' USING ERRCODE = 'P0001';
		END IF;
		RETURN stored_message;
	END IF;
	UPDATE "inbox_messages"
	SET "status" = 'replied', "reply" = p_reply, "replied_at" = p_replied_at
	WHERE "id" = p_message_id AND "run_id" = p_run_id AND "status" = 'pending'
	RETURNING * INTO stored_message;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'agentos_invalid_inbox_state' USING ERRCODE = 'P0001';
	END IF;
	PERFORM "agentos_append_event"(
		p_run_id, p_event_id, p_event_fingerprint, p_event_type, p_event_payload, p_occurred_at
	);
	RETURN stored_message;
END;
$$;
