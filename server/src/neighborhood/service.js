const { ConflictError, NotFoundError, ValidationError } = require("../errors");

const orderSteps = ["待确认", "已接单", "服务中", "待验收", "已完成", "争议中"];

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError([{ field, message: "请填写有效文本" }]);
  }
  return value.trim();
}

function parseRelativePostAgeMinutes(timeText = "") {
  if (/刚刚|刚才/.test(timeText)) return 0;
  const minute = String(timeText).match(/(\d+)\s*分钟/);
  if (minute) return Number(minute[1]);
  const hour = String(timeText).match(/(\d+)\s*小时/);
  if (hour) return Number(hour[1]) * 60;
  const day = String(timeText).match(/(\d+)\s*天/);
  if (day) return Number(day[1]) * 24 * 60;
  return 0;
}

function inferPostStatus(post) {
  const text = `${post?.title || ""}${post?.text || ""}${post?.status || ""}`;
  const ageMinutes = parseRelativePostAgeMinutes(post?.time || "");
  const hasSolvedSignal = /已解决|解决了|已经解决|已完成|完成了|不用了|找到了|已找到|已处理|已借到|已接到/.test(text);
  const hasExpiredSignal = /已过期|过期|来不及|错过|截止|结束了/.test(text);
  const hasTonightDeadline = /今晚|今天|下班前|\d{1,2}\s*点前/.test(text);
  const isStaleRequest = post?.category === "ask" && (ageMinutes >= 24 * 60 || (hasTonightDeadline && ageMinutes >= 12 * 60));

  if (hasSolvedSignal) return { status: "已解决", reason: "AI 检查到帖子内容里有已解决、已完成或已找到的表达。" };
  if (hasExpiredSignal || isStaleRequest) return { status: "已过期", reason: "AI 检查到帖子已超过时效，或内容里出现过期/截止相关表达。" };
  return { status: "未解决", reason: "AI 未发现已解决或过期信号，帖子仍可继续响应。" };
}

function normalizePostCheckStatus(value) {
  if (["未解决", "已解决", "已过期"].includes(value)) return value;
  if (/solved|resolved|done|完成|解决/.test(String(value || "").toLowerCase())) return "已解决";
  if (/expired|stale|timeout|过期|超时|截止/.test(String(value || "").toLowerCase())) return "已过期";
  return "未解决";
}

function extractJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callPostStatusModel(post, fallback, env = process.env) {
  const apiKey = env.ASSISTANT_API_KEY;
  const baseUrl = env.ASSISTANT_BASE_URL || "https://api.aigcly.top";
  const model = env.ASSISTANT_MODEL || "grok-4.20-multi-agent-xhigh";
  if (!apiKey) return { ...fallback, source: "local_rules", model: "local-post-status-rules" };

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "你是邻里帮后台帖子状态巡检助手。只根据帖子内容、发布时间、当前状态判断帖子是否仍可响应。只返回 JSON，不要解释，格式为 {\"status\":\"未解决|已解决|已过期\",\"reason\":\"一句后台处理原因\"}。如果证据不足，返回未解决。",
          },
          {
            role: "user",
            content: JSON.stringify({
              title: post.title || "",
              text: post.text || "",
              time: post.time || "",
              category: post.category || "",
              status: post.status || "",
            }),
          },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      return { ...fallback, source: "local_rules", model: "local-post-status-rules", modelError: response.status };
    }

    const raw = await response.text();
    const payload = parseModelPayload(raw);
    const content = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.delta?.content;
    const parsed = extractJsonObject(content);
    if (!parsed) return { ...fallback, source: "local_rules", model: "local-post-status-rules", modelError: "invalid_json" };

    return {
      status: normalizePostCheckStatus(parsed.status),
      reason: parsed.reason || fallback.reason,
      source: "model",
      model,
    };
  } catch (error) {
    return { ...fallback, source: "local_rules", model: "local-post-status-rules", modelError: error.message };
  }
}

async function checkCommunityPost(input = {}, env = process.env) {
  if (!input || typeof input !== "object") throw new ValidationError([{ field: "body", message: "请求体不能为空" }]);
  const post = input.post || input;
  requireText(post.title || post.text, "post");
  const fallback = inferPostStatus(post);
  const result = await callPostStatusModel(post, fallback, env);
  return {
    ...result,
    checkedAt: new Date().toISOString(),
  };
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

function normalizeAssistantLocation(raw, matchedLocation) {
  const namedStation = raw.match(/((?:中通|菜鸟|圆通|申通|韵达|顺丰|京东|丰巢)[^，。,\.\s]{0,6}(?:快递站|驿站|快递柜|门口))/);
  if (namedStation) return namedStation[1];
  const communityPlace = raw.match(/(小区门口|北门|南门|东门|西门|物业中心)/);
  if (communityPlace) return communityPlace[1];
  return matchedLocation || "小区快递站";
}

function detectRouteIntent(text) {
  const raw = requireText(text, "message");
  const isGoing = /去|路过|顺路|经过|到/.test(raw);
  const isStation = /快递站|驿站|菜鸟|丰巢|快递柜|门口/.test(raw);
  const asksForHelp = /帮我|求助|需要.*帮|谁能|能不能.*帮|有没有人.*帮|没时间|来不及|不方便|代取|带回|取一下|拿一下|接送|接一下|帮忙接|照看|看护/.test(raw);
  const offersHelp = /有没有.*要|谁要|可以帮|顺手帮|顺路帮|帮邻居|带快递的|要带|可帮/.test(raw);
  const locationMatch = raw.match(/([^，。,.\s]{1,12}(?:快递站|驿站|快递柜|门口))/);
  const timeMatch = raw.match(/今天|今晚|明天|上午|下午|晚上|\d{1,2}\s*点/);

  return {
    raw,
    type: asksForHelp ? "help_request" : offersHelp || (isGoing && isStation) ? "route_offer" : "general_help",
    location: normalizeAssistantLocation(raw, locationMatch?.[1]),
    time: timeMatch?.[0] || "今天",
  };
}

function inferAssistantService(intent) {
  if (/接送|接一下|帮忙接|孩子|小孩|学校|幼儿园/.test(intent.raw)) return "求助接送";
  if (/快递|驿站|快递站|快递柜|取件/.test(intent.raw)) return intent.type === "help_request" ? "求助取件" : "顺路帮取";
  if (/买菜|超市|带菜|采购/.test(intent.raw)) return intent.type === "help_request" ? "求助代买" : "顺路代买";
  return intent.type === "help_request" ? "求助互助" : intent.type === "route_offer" ? "顺路互助" : "邻里互助";
}

function buildAssistantDescription(intent, serviceTag) {
  if (serviceTag === "求助接送") return `${intent.time}没时间接送孩子，想请邻居帮忙接一下，可免费或付费协商。`;
  if (serviceTag === "求助取件") return `${intent.time}想请邻居帮忙从${intent.location}取快递。`;
  if (serviceTag === "顺路帮取") return `${intent.time}去${intent.location}，可以顺手帮邻居取小件快递。`;
  return intent.raw;
}

function findNearbyRequests(intent) {
  const requests = [
    {
      id: "help-101",
      title: "顺手取一个快递",
      requester: "安安",
      place: "3栋楼下",
      distance: 80,
      budget: 5,
      text: `在${intent.location}有一个小件快递，想请顺路邻居带到 3 栋楼下。`,
      mode: "paid",
    },
    {
      id: "help-102",
      title: "帮忙看下快递柜编号",
      requester: "阿树",
      place: "小区门口",
      distance: 140,
      budget: 0,
      text: `如果路过${intent.location}，想麻烦拍一下取件柜屏幕提示。`,
      mode: "free",
    },
    {
      id: "help-103",
      title: "代取文件袋",
      requester: "林小禾",
      place: "5栋门口",
      distance: 220,
      budget: 8,
      text: `今天有个文件袋到${intent.location}，希望同小区邻居顺手带回。`,
      mode: "paid",
    },
  ];

  return requests
    .map((item) => ({ ...item, score: Math.max(60, 96 - Math.round(item.distance / 8)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function findNearbyHelpers(intent) {
  if (/接送|接一下|帮忙接|孩子|小孩|学校|幼儿园/.test(intent.raw)) {
    return [
      {
        id: "helper-child-101",
        helper: "林小禾",
        title: "同小区家长可帮接孩子",
        place: "小区北门",
        distance: 180,
        budget: 15,
        text: "林小禾今天 18:00 左右在小区北门附近，可帮忙接孩子到门岗或楼下。",
        mode: "paid",
        score: 91,
      },
      {
        id: "helper-child-102",
        helper: "王启明",
        title: "3栋邻居可临时照应",
        place: "3栋楼下",
        distance: 80,
        budget: 0,
        text: "王启明傍晚在 3 栋附近，可短时间帮忙照应，建议先确认孩子信息。",
        mode: "free",
        score: 86,
      },
    ];
  }
  return [
    {
      id: "helper-101",
      helper: "王启明",
      title: "3栋邻居可帮取件",
      place: "3栋楼下",
      distance: 80,
      budget: 6,
      text: `王启明今天会路过${intent.location}，可帮忙带小件快递到 3 栋楼下。`,
      mode: "paid",
      score: 92,
    },
    {
      id: "helper-102",
      helper: "林小禾",
      title: "物业认证服务者可接单",
      place: "5栋门口",
      distance: 220,
      budget: 8,
      text: `林小禾可在${intent.time}去${intent.location}取件，支持送到楼下。`,
      mode: "paid",
      score: 84,
    },
    {
      id: "helper-103",
      helper: "陈海",
      title: "社区达人顺手帮忙",
      place: "1栋",
      distance: 410,
      budget: 0,
      text: "陈海常在小区门口附近活动，可以免费帮看快递柜编号。",
      mode: "free",
      score: 73,
    },
  ];
}

function buildAssistantFallback(store, message) {
  store.read();
  const intent = detectRouteIntent(message);
  const nearbyRequests = findNearbyRequests(intent);
  const nearbyHelpers = intent.type === "help_request" ? findNearbyHelpers(intent) : [];
  const serviceTag = inferAssistantService(intent);
  const publishTask = {
    id: `ai-${Date.now()}`,
    serviceTag,
    category: intent.type === "help_request" ? "ask" : "offer",
    description: buildAssistantDescription(intent, serviceTag),
    time: intent.time,
    location: intent.location,
    budget: 0,
    negotiable: true,
    riskLevel: "绿色 - 低风险",
    authRule: "手机号 + 同小区认证优先",
    evidenceRule: "取件拍照 + 送达确认",
    type: "service",
  };

  return {
    reply:
      intent.type === "route_offer"
        ? `我识别到你今天会去${intent.location}，可以把这条顺路能力发布成互助，也可以先看看附近有没有人正好需要帮忙。`
        : intent.type === "help_request"
          ? `我理解你是在求帮助：${buildAssistantDescription(intent, serviceTag)} 我先帮你找了附近可能能帮忙的人，也可以整理成求助帖发到发现页。`
        : "我可以帮你把需求整理成邻里互助任务，并匹配附近可响应的人。",
    intent,
    nearbyRequests: intent.type === "help_request" ? [] : nearbyRequests,
    nearbyHelpers,
    publishTask,
    quickReplies: intent.type === "help_request" ? ["发布求助帖", "邀请附近邻居", "改成付费求助"] : ["自动发布顺路任务", "看看附近求助", "改成付费帮助"],
    source: "local_rules",
  };
}

async function callAssistantModel(message, fallback, env = process.env) {
  const apiKey = env.ASSISTANT_API_KEY;
  const baseUrl = env.ASSISTANT_BASE_URL || "https://api.aigcly.top";
  const model = env.ASSISTANT_MODEL || "grok-4.20-multi-agent-xhigh";
  if (!apiKey) return fallback;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "你是邻里帮的对话式 AI 助手。先判断用户是在提供帮助还是需要帮助：例如'我今天去中通快递站，有没有邻居要带快递的'是提供帮助；'谁能帮我取快递'是需要帮助。只返回 JSON，字段为 reply, quickReplies。语气温暖、简洁、可靠。",
        },
        { role: "user", content: message },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) return { ...fallback, source: "local_rules", modelError: response.status };
  const raw = await response.text();
  const payload = parseModelPayload(raw);
  const content = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.delta?.content;
  if (!content) return fallback;

  try {
    const parsed = JSON.parse(content);
    return {
      ...fallback,
      reply: parsed.reply || fallback.reply,
      quickReplies: Array.isArray(parsed.quickReplies) ? parsed.quickReplies.slice(0, 4) : fallback.quickReplies,
      source: "model",
    };
  } catch {
    return { ...fallback, reply: content, source: "model" };
  }
}

function parseModelPayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const chunks = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:") && line !== "data: [DONE]")
      .map((line) => line.slice(5).trim());
    const contents = [];
    let lastPayload = null;
    for (const chunk of chunks) {
      try {
        const parsed = JSON.parse(chunk);
        lastPayload = parsed;
        const delta = parsed.choices?.[0]?.delta?.content;
        const message = parsed.choices?.[0]?.message?.content;
        if (delta) contents.push(delta);
        if (message) contents.push(message);
      } catch {
        // Ignore malformed stream fragments and fall back to local rules.
      }
    }
    if (contents.length) return { choices: [{ message: { content: contents.join("") } }] };
    return lastPayload;
  }
}

async function assistantChat(store, input, env = process.env) {
  if (!input || typeof input !== "object") throw new ValidationError([{ field: "body", message: "请求体不能为空" }]);
  const message = requireText(input.message, "message");
  const fallback = buildAssistantFallback(store, message);
  return callAssistantModel(message, fallback, env);
}

function decodeAudioData(input) {
  if (!input || typeof input !== "object") throw new ValidationError([{ field: "body", message: "请求体不能为空" }]);
  const audioBase64 = requireText(input.audioBase64, "audioBase64");
  const audio = Buffer.from(audioBase64.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!audio.length) throw new ValidationError([{ field: "audioBase64", message: "语音内容不能为空" }]);
  if (audio.length > 3 * 1024 * 1024) throw new ValidationError([{ field: "audioBase64", message: "语音不能超过 3MB" }]);
  return {
    audio,
    mimeType: input.mimeType || "audio/webm",
    filename: input.filename || "assistant-voice.webm",
  };
}

async function transcribeAssistantAudio(input, env = process.env) {
  const apiKey = env.ASSISTANT_API_KEY;
  if (!apiKey) throw new ValidationError([{ field: "ASSISTANT_API_KEY", message: "未配置语音转文字 API Key" }]);
  const { audio, mimeType, filename } = decodeAudioData(input);
  const baseUrl = env.ASSISTANT_BASE_URL || "https://api.aigcly.top";
  const model = env.ASSISTANT_TRANSCRIBE_MODEL || env.ASSISTANT_STT_MODEL || "whisper-1";
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([audio], { type: mimeType }), filename);

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new ValidationError([{ field: "voice", message: `语音转文字失败：${response.status}` }]);
  const result = await response.json();
  return requireText(result.text || result.transcript || result.message, "transcript");
}

async function assistantVoiceChat(store, input, env = process.env) {
  const transcript = await transcribeAssistantAudio(input, env);
  const result = await assistantChat(store, { message: transcript }, env);
  return { ...result, transcript };
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
  assistantChat,
  assistantVoiceChat,
  checkCommunityPost,
  rankWorkers,
  suggestPrice,
};
