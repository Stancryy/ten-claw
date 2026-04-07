const Redis = require("ioredis");
const redis = new Redis("redis://localhost:6379");

async function inspect() {
  const key = "tenclaw:workflow:runs:demo-tenant:demo-workspace:demo-project:run_1775561379927_8b2wfn6c";
  const data = await redis.get(key);
  const state = JSON.parse(data);
  
  console.log("Top-level keys:", Object.keys(state));
  console.log("\nrunId:", state.runId);
  console.log("status:", state.status);
  console.log("currentAgentId:", state.currentAgentId);
  console.log("\nHas 'artifacts':", !!state.artifacts);
  console.log("Artifacts count:", state.artifacts?.length || 0);
  console.log("\nHas 'routingDecisions':", !!state.routingDecisions);
  console.log("Routing decisions count:", state.routingDecisions?.length || 0);
  
  if (state.routingDecisions?.length > 0) {
    console.log("\nFirst routing decision:", JSON.stringify(state.routingDecisions[0], null, 2));
  }
  
  await redis.quit();
}

inspect().catch(console.error);
