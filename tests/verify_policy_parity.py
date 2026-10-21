"""Check that browser and production server recommend the same budget actions."""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from server import evaluate_campaign  # noqa: E402

base = dict(daily_budget=500, spend=500, revenue=1600, conversions=5,
            has_conversion=True, data_fresh=True, target_roi=1.5,
            max_daily_budget=1000, min_spend=100)
cases = [base, {**base, "daily_budget": 900},
         {**base, "has_conversion": False, "revenue": 0, "conversions": None},
         {**base, "has_conversion": False, "spend": 600, "conversions": None},
         {**base, "data_fresh": False},
         {**base, "revenue": 0, "conversions": 0},
         {**base, "spend": 30, "revenue": 60},
         {**base, "revenue": 800},
         {**base, "revenue": 1600, "conversions": 1},
         {**base, "daily_budget": 1200},
         {**base, "daily_budget": 1200, "data_fresh": False}]
script = """
import {evaluateCampaign} from './legacy/workspace/domain.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
console.log(JSON.stringify(JSON.parse(input).map(evaluateCampaign)));
"""
browser = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script],
                     input=json.dumps(cases).encode(), cwd=ROOT))
for i, (case, expected) in enumerate(zip(cases, browser)):
    actual = evaluate_campaign(case)
    for key in ("action", "newBudget", "roi"):
        assert actual[key] == expected[key], f"case {i}, {key}: server={actual[key]}, browser={expected[key]}"
print(f"PASS: {len(cases)} browser/server budget-policy cases match.")
