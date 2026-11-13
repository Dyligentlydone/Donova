# DECISIONS — spec decisions made during implementation

## 2026-11-13 — Studio chat agent model: DeepSeek V4.1 Flash

**Decision:** the hosted chat agent (apps/web `/api/chat` → `@donova/studio-server/agent`)
runs on **DeepSeek V4.1 Flash** (`deepseek-flash`) via DeepSeek's
Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`), thinking
mode disabled.

**Why not Claude Haiku 5.5 ($0.10/$0.50):** Haiku was cheaper on paper and a
zero-code swap, but the owner chose DeepSeek for cost headroom at scale
(off-peak $0.15/$0.60) and product preference. The provider is env-configurable
(`DONOVA_LLM_BASE_URL`/`DONOVA_LLM_API_KEY`/`DONOVA_LLM_MODEL`, Anthropic envs
as fallback) so switching back is a redeploy, not a code change. Revisit if
tool-use quality disappoints — Haiku remains the fallback pick.

**Verified:** `/anthropic/messages` returns 401 (exists); DeepSeek docs confirm
client tools + `tool_use`/`tool_result` + `thinking:{type:"disabled"}` on that
protocol. Rules fallback verified working with no key.

**Usage caps (same date):** trial = 25 lifetime chats; paid = 300 chats/month +
4M-token monthly ceiling; owners uncapped. Counters live on the GCS
`subscribers/<sha256>.json` record (`trialChats`, `usage{month,chats,tokensIn,
tokensOut}`); enforced + returned (`chatRemaining`) in `/api/chat`. Soft-cap
caveat: GCS read-modify-write can lose counts across concurrent containers.
