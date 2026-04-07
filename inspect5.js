const Redis = require("ioredis");
const redis = new Redis("redis://localhost:6379");

async function inspect() {
  // Get a recent running workflow
  const key = "tenclaw:workflow:runs:demo-tenant:demo-workspace:demo-project:run_1775456105117_b70s32no";
  const data = await redis.get(key);
  const state = JSON.parse(data);
  
  console.log("=== Workflow State Structure ===");
  console.log("Keys:", Object.keys(state));
  console.log("\nrunId:", state.runId);
  console.log("status:", state.status);
  console.log("agentType:", state.agentType);
  console.log("\nHas 'team':", !!state.team);
  if (state.team) {
    console.log("team.id:", state.team.id);
    console.log("team.name:", state.team.name);
  }
  console.log("\nHas 'request':", !!state.request);
  if (state.request) {
    console.log("request.teamId:", state.request.teamId);
  }
  console.log("\nHas 'routingDecisions':", !!state.routingDecisions);
  console.log("routingDecisions count:", state.routingDecisions?.length || 0);
  if (state.routingDecisions?.length > 0) {
    console.log("First routingDecision:", JSON.stringify(state.routingDecisions[0], null, 2));
  }
  
  console.log("\n=== Getting all agent index keys to find defined teams ===");
  const agentKeys = await redis.keys("tenclaw:workflow:index:agent:*");
  console.log("All agent keys:", agentKeys);
  
  await redis.quit();
}

inspect().catch(console.error);
