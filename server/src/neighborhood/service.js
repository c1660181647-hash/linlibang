const { ConflictError, NotFoundError, ValidationError } = require("../errors");

const orderSteps = ["待确认", "已接单", "服务中", "待验收", "已完成", "争议中"];

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError([{ field, message: "请填写有效文本" }]);
  }
  return value.trim();
}

function compactBuilding(value) {
  return value.replace(/\s+/g, "");
}

function parseTaskText(text) {
  const raw = requireText(text, "text");
  const isTool = /借|小推车|梯|工具|电钻|轮椅|折叠/.test(raw);
  const isMedical = /陪诊|医院|挂号|老人|妈妈|儿童|门诊|医疗/.test(raw);
  const isMoving = /搬|搬运|收纳|箱|书/.test(raw);
  const serviceTag = isMedical ? "陪诊调度" : isTool ? "工具借用" : isMoving ? "小型搬运" : "代取快递";
  const priceMatch = raw.match(/(\d+)\s*元/);
  const budget = priceMatch ? Number(priceMatch[1]) : isMedical ? 100 : isTool ? 0 : isMoving ? 25 : 10;
  const timeMatch = raw.match(/今晚|今天|明天|周[一二三四五六日天]|上午|下午|晚上|[0-9]{1,2}\s*点(?:前|后)?/);
  const locationMatches = raw.match(/小区门口|[1-9]\s*栋(?:楼下|门口|大堂)?|楼下|花园|物业中心/g) || [];
  const riskLevel = isMedical ? "红色 - 高风险" : "绿色 - 低风险";
  const missing = [];

  if (!isTool && !/是否|需要|上楼|重量|多重|多久|半小时/.test(raw)) {
    missing.push("建议补充是否需要上楼、物品大小和是否可议价");
  }
  if (isTool && !/归还|半小时|小时|明天|今天/.test(raw)) {
    missing.push("建议补充预计归还时间");
  }

  return {
    id: `task-${Date.now()}`,
    raw,
    serviceTag,
    description: raw,
    time: timeMatch ? timeMatch[0].replace(/\s+/g, "") : "今天内",
    location: locationMatches.length
      ? Array.from(new Set(locationMatches.map(compactBuilding))).join(" / ")
      : "同小区",
    budget,
    negotiable: /议价|以内|预算|元/.test(raw),
    riskLevel,
    authRule: isMedical ? "仅机构认证服务者可接单" : "手机号 + 同小区认证优先",
    evidenceRule: isTool ? "取还双方确认 + 到期提醒" : "送达拍照 + 需求方确认",
    missing,
    type: isTool ? "tool" : isMedical ? "high-risk" : "service",
  };
}

function suggestPrice(task) {
  const table = {
    "代取快递": [8, 15],
    "小型搬运": [18, 35],
    "工具借用": [0, 8],
    "陪诊调度": [80, 160],
  };
  const range = table[task.serviceTag] || [10, 30];
  const [low, high] = range;
  let note = `期望价位于参考区间 ${low}-${high} 元内。`;
  if (task.budget < low) note = `期望价低于参考区间 ${low}-${high} 元，可能需要补充任务很简单或允许议价。`;
  if (task.budget > high) note = `期望价高于参考区间 ${low}-${high} 元，通常能更快获得响应。`;
  return { range, low, high, note };
}

function rankWorkers(task, users) {
  return users
    .filter((user) => {
      if (task.type === "high-risk") return user.verified.includes("机构认证");
      if (task.type === "tool") return user.skills.includes("工具借还");
      return user.skills.includes(task.serviceTag) || user.skills.includes("代取快递");
    })
    .map((user) => {
      const distanceScore = Math.max(0, 25 - user.distance / 40);
      const authScore = Math.min(20, user.verified.length * 6.5);
      const quoteScore = Math.max(0, 20 - Math.abs(user.baseQuote - task.budget) * 1.8);
      const skillScore = user.skills.includes(task.serviceTag) ? 15 : 10;
      const creditScore = Math.min(15, user.credit / 7);
      const responseScore = Math.max(1, 6 - user.avgResponse / 3);
      const score = Math.round(distanceScore + authScore + quoteScore + skillScore + creditScore + responseScore);
      const quote = task.type === "tool" ? 0 : Math.max(user.baseQuote, Math.round(task.budget || user.baseQuote));

      return {
        ...user,
        quote,
        score,
        reason: `${user.building}，距离约 ${user.distance} 米；${user.verified.join("、")}；完成 ${user.completed} 单，评分 ${user.rating}。`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function parseAndMatch(store, text) {
  const data = store.read();
  const task = parseTaskText(text);
  const priceAdvice = suggestPrice(task);
  const matches = rankWorkers(task, data.users);
  return {
    task,
    priceAdvice,
    matches,
    agentLog: [
      {
        tool: "parse_task",
        text: `识别为「${task.serviceTag}」，风险等级为「${task.riskLevel}」。`,
      },
      { tool: "suggest_price", text: priceAdvice.note },
      { tool: "rank_workers", text: `已按距离、认证、报价和信用排序出 ${matches.length} 位候选人。` },
    ],
  };
}

function findOrder(data, id) {
  const order = data.orders.find((item) => item.id === id);
  if (!order) throw new NotFoundError("订单", id);
  return order;
}

function createOrder(store, input) {
  if (!input || typeof input !== "object") throw new ValidationError([{ field: "body", message: "请求体不能为空" }]);
  if (!input.task || typeof input.task !== "object") throw new ValidationError([{ field: "task", message: "任务不能为空" }]);

  return store.update((data) => {
    const candidate =
      input.candidate ||
      data.users.find((user) => user.id === input.candidateId) ||
      data.users.find((user) => user.id === input.task.candidateId);
    if (!candidate) throw new NotFoundError("候选人", input.candidateId || input.task.candidateId || "unknown");

    const order = {
      id: `NB-${String(data.orders.length + 1).padStart(4, "0")}`,
      task: input.task,
      candidate: {
        id: candidate.id,
        name: candidate.name,
        role: candidate.role,
        quote: candidate.quote ?? Math.max(candidate.baseQuote || 0, input.task.budget || 0),
      },
      source: input.source || "task",
      price: input.source === "tool" ? input.task.budget : candidate.quote ?? Math.max(candidate.baseQuote || 0, input.task.budget || 0),
      statusIndex: input.statusIndex || 0,
      status: orderSteps[input.statusIndex || 0],
      createdAt: new Date().toISOString(),
      evidence: [],
    };
    data.orders.unshift(order);
    return order;
  });
}

function advanceOrder(store, id) {
  return store.update((data) => {
    const order = findOrder(data, id);
    if (order.statusIndex >= 4) throw new ConflictError("订单已结束，不能继续推进", [{ field: "status" }]);
    order.statusIndex = Math.min(order.statusIndex + 1, 4);
    order.status = orderSteps[order.statusIndex];
    return order;
  });
}

function addEvidence(store, id, note = "完成凭证已提交") {
  return store.update((data) => {
    const order = findOrder(data, id);
    order.evidence.push(requireText(note, "note"));
    order.statusIndex = 3;
    order.status = orderSteps[3];
    return order;
  });
}

function disputeOrder(store, id, reason = "用户发起争议") {
  return store.update((data) => {
    const order = findOrder(data, id);
    order.statusIndex = 5;
    order.status = orderSteps[5];
    order.dispute = { reason: requireText(reason, "reason"), createdAt: new Date().toISOString() };
    return order;
  });
}

function borrowTool(store, toolId, borrowerId = "me") {
  return store.update((data) => {
    const tool = data.tools.find((item) => item.id === toolId);
    if (!tool) throw new NotFoundError("工具", toolId);
    if (tool.status !== "可借") throw new ConflictError("工具当前不可借", [{ field: "status", value: tool.status }]);

    const order = {
      id: `NB-${String(data.orders.length + 1).padStart(4, "0")}`,
      task: {
        id: `borrow-${Date.now()}`,
        serviceTag: "工具借用",
        description: `申请借用${tool.name}`,
        time: tool.availability,
        location: tool.building,
        budget: tool.price,
        negotiable: false,
        riskLevel: "绿色 - 低风险",
        authRule: tool.deposit,
        evidenceRule: "取用确认 + 归还确认 + 到期提醒",
        type: "tool",
      },
      candidate: { id: tool.id, name: tool.owner, role: "物主", quote: tool.price },
      borrowerId,
      source: "tool",
      price: tool.price,
      statusIndex: 1,
      status: orderSteps[1],
      createdAt: new Date().toISOString(),
      evidence: [],
    };
    data.orders.unshift(order);
    return order;
  });
}

module.exports = {
  addEvidence,
  advanceOrder,
  borrowTool,
  createOrder,
  disputeOrder,
  orderSteps,
  parseAndMatch,
  parseTaskText,
  rankWorkers,
  suggestPrice,
};
