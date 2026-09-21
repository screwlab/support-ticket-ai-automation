.DEFAULT_GOAL := test
.PHONY: test start smoke stop reset

WEBHOOK = http://localhost:5678/webhook/support-ticket

test:
	node --test tests/workflow.test.mjs
	python3 -m unittest discover -s tests -v

# Workflow id == file name. CLI imports only take effect after a restart.
start:
	docker compose up -d --wait
	for id in ticket-routing mock-model; do \
		docker compose exec -T n8n n8n import:workflow --input=/workflows/$$id.json && \
		docker compose exec -T n8n n8n publish:workflow --id=$$id; \
	done
	docker compose restart n8n && docker compose up -d --wait
	@echo 'n8n: http://localhost:5678 - add a DeepSeek credential named "DeepSeek account" and rerun make start (see README)'

# Ticket ids carry a timestamp so a rerun does not trip the duplicate check.
# 429/503: three attempts with 1s+2s backoff -> needs_review; 200: reply is not JSON -> needs_review without retry.
smoke:
	@post() { printf '\n=== %s ===\n' "$$1"; shift; curl -s -w ' [%{http_code}, %{time_total}s]\n' -X POST $(WEBHOOK) -H 'Content-Type: application/json' "$$@"; }; \
	t=$$(date +%s); \
	ticket='{"ticket_id":"TK-9082-'$$t'","customer_email":"john.doe@techcorp.com","message":"Hi, your API returns 500 error on /v1/billing endpoint. Fix this ASAP!","tier":"Enterprise"}'; \
	post 'Enterprise + Critical -> asana_slack' -d "$$ticket"; \
	post 'same ticket_id again -> duplicate, no second Asana/Slack' -d "$$ticket"; \
	post 'Free tier -> hubspot, PII masked' -d '{"ticket_id":"TK-2-'$$t'","customer_email":"jane@example.com","message":"Contact me at jane@example.com or +1-202-555-0143 about billing.","tier":"Free"}'; \
	post 'invalid email -> 400' -d '{"ticket_id":"TK-1-'$$t'","customer_email":"not-an-email","message":"Hi","tier":"Enterprise"}'; \
	for s in 429 503 200; do \
		post "model answers $$s on every attempt" -H "X-Mock-Model-Status: $$s" -d '{"ticket_id":"TK-'$$s'-'$$t'","customer_email":"a@b.com","message":"API down","tier":"Enterprise"}'; \
	done

stop:
	docker compose down

reset:  # also drops n8n's database: workflows, credentials, executions, dedupe state
	docker compose down -v
