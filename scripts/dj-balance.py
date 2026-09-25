# READ ONLY. Run INSIDE the Nesher-CRM container (Django shell): prints ONE JSON line - every reservation's id and the
# CRM's own Reservation.remaining_balance, plus the tables/columns that property reads. No names, no notes, no codes.
# Used by scripts/drift-balance.mjs (Gabbai money-sat C5): crm-search REMAINING_BALANCE_SQL must equal this on every
# reservation. Re-run after ANY Nesher-CRM deploy that touches Reservation total_customer_price,
# total_refunds_to_customer or total_paid.
#   railway ssh -p <project> -e <env> -s <Nesher-CRM service> -i <key> -- sh -c "cd /app && .venv/bin/python manage.py shell" < scripts/dj-balance.py > dj-balance.json
import json
from core.models import Reservation as R
meta = {}
for rel in ("journeys", "travelers", "refunds", "payments", "customer_payment_applications", "organization_sponsorships"):
    f = R._meta.get_field(rel)
    m = f.related_model
    meta[rel] = {"table": m._meta.db_table, "fk": f.field.column, "fields": [x.column for x in m._meta.concrete_fields if x.column in ("customer_price", "line_type", "amount", "applied_amount", "is_active", "amount_to_customer", "legacy_payment_id")]}
meta["reservation"] = {"table": R._meta.db_table, "pricing_mode": any(x.name == "pricing_mode" for x in R._meta.concrete_fields)}
rows = [[r.id, str(r.remaining_balance)] for r in R.objects.all().order_by("id")]
print(json.dumps({"meta": meta, "n": len(rows), "rows": rows}))
