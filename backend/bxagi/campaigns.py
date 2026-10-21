"""Pure campaign recommendation rules; never executes advertising actions."""
from __future__ import annotations


def evaluate_campaign(campaign):
    budget = campaign["daily_budget"]
    cap = min(1000, campaign["max_daily_budget"])
    if campaign.get("data_fresh") is not True:
        return {"action": "hold", "reason": "数据已过期或新鲜度未确认，保持草案预算", "newBudget": budget, "roi": None}
    if budget > cap:
        return {"action": "approval", "reason": "当前预算超过人工审批上限，需人工审核；未执行调整", "newBudget": budget, "roi": None}
    if campaign.get("has_conversion") is False or campaign.get("conversions") is None or campaign.get("spend") is None or campaign.get("revenue") is None:
        if campaign.get("spend") is not None and campaign["spend"] >= budget:
            return {"action": "pause", "reason": "缺少转化数据且消耗达到每日预算，建议暂停并核实数据；未执行操作", "newBudget": budget, "roi": None}
        return {"action": "hold", "reason": "缺少已确认的转化或收支数据，不能据此调整预算", "newBudget": budget, "roi": None}
    spend, revenue = campaign["spend"], campaign["revenue"]
    roi = revenue / spend if spend > 0 else None
    if spend < campaign["min_spend"] or roi is None:
        return {"action": "hold", "reason": "已消费样本不足，暂不调整预算", "newBudget": budget, "roi": roi}
    if roi < campaign["target_roi"] * 0.65:
        return {"action": "pause", "reason": "收入/消耗低于目标，建议人工审阅后暂停；未执行任何投放操作", "newBudget": budget, "roi": roi}
    if roi >= campaign["target_roi"] * 1.15 and campaign["conversions"] >= 3:
        suggested = round(budget * 1.2, 2)
        if suggested > cap:
            return {"action": "approval", "reason": "建议增加 20% 后将超过预算上限，需人工审批；未执行调整", "newBudget": suggested, "roi": roi}
        return {"action": "increase", "reason": "ROI 和转化样本达到规则要求，建议增加 20%；未执行投放操作", "newBudget": suggested, "roi": roi}
    return {"action": "hold", "reason": "尚未满足加量或暂停规则，保持草案预算", "newBudget": budget, "roi": roi}
