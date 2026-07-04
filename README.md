# 邻里帮 Agent Demo

这是一个「社区互助 + Agent 发单」原型，包含移动端首页、居民端任务发布、工具借用、候选人匹配和订单履约闭环。

## 已实现

- 移动端首页：暖白背景、社区感 Hero、快捷入口、附近动态、底部导航。
- 个人资料：点击头像可上传本地照片并修改昵称，头像圆形裁剪展示。
- Agent 任务解析：识别代取快递、小型搬运、工具借用、陪诊调度等需求。
- 候选人匹配：按距离、认证、报价、信用、响应速度排序。
- 价格建议：给出服务参考价区间和议价提示。
- 工具借用：小推车、折叠梯、工具箱等共享工具可生成借用工单。
- 订单流转：待确认、已接单、服务中、待验收、已完成、争议中。
- 后端 API：Node.js 原生 HTTP 服务，无需安装第三方依赖，JSON 文件持久化。

## 运行后端

```powershell
npm start
```

默认地址：

```text
http://127.0.0.1:3001/
http://127.0.0.1:3001/mobile.html
```

配置项见 `.env.example`。当前实现不依赖 dotenv，如需修改端口可直接在 PowerShell 设置环境变量：

```powershell
$env:PORT="3002"; npm start
```

## 测试

```powershell
npm test
```

测试覆盖：

- 任务解析与候选人匹配
- 工单创建和状态推进
- 工具借用生成工单
- 空输入结构化校验错误

## API 概览

```text
GET    /health
GET    /ready
GET    /api/profile
GET    /api/users
GET    /api/tools
GET    /api/orders
GET    /api/community/feed
POST   /api/tasks/parse
POST   /api/orders
PATCH  /api/orders/:id/advance
PATCH  /api/orders/:id/evidence
PATCH  /api/orders/:id/dispute
POST   /api/tools/:id/borrow
```

示例：

```powershell
Invoke-WebRequest `
  -Uri "http://127.0.0.1:3001/api/tasks/parse" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"text":"今晚 7 点前帮我从小区门口取个快递，送到 3 栋楼下，10 元以内。"}'
```

## 目录

```text
server/
  index.js                     # 服务入口和优雅关闭
  src/app.js                   # HTTP 路由、静态文件服务、统一错误响应
  src/config.js                # 环境配置
  src/data/store.js            # JSON 文件存储
  src/neighborhood/seed.js     # 初始用户、工具、动态数据
  src/neighborhood/service.js  # 任务解析、匹配、订单、工具借用业务规则
  tests/neighborhood.test.js   # 后端行为测试
```

## 下一步建议

1. 接入真实账号体系：手机号登录、小区认证、角色权限。
2. 将 JSON store 替换为 SQLite 或 PostgreSQL，并加入迁移脚本。
3. 增加头像上传接口：先本地文件存储，后续可换对象存储。
4. 前端接入 API client，把当前 localStorage/mock 数据逐步替换为后端数据。
