const Redis = require("ioredis");
const redis = new Redis("redis://localhost:6379");

async function inspect() {
  const key = "tenclaw:workflow:runs:demo-tenant:demo-workspace:demo-project:run_1775561379927_8b2wfn6c";
  const data = await redis.get(key);
  const state = JSON.parse(data);
  
  console.log("messageHistory length:", state.messageHistory?.length || 0);
  console.log("\nFirst 5 message kinds:");
  state.messageHistory?.slice(0, 5).forEach((m, i) => {
    console.log(`  [${i}] kind: ${m.kind}, sender: ${m.senderAgentId || 'none'}`);
  });
  
  console.log("\ntask.completed / task.failed messages:");
  const taskMessages = state.messageHistory?.filter(m => 
    m.kind === "task.completed" || m.kind === "task.failed"
  );
  console.log("  Count:", taskMessages?.length || 0);
  
  if (taskMessages?.length > 0) {
    console.log("\n  First task message structure:");
    const first = taskMessages[0];
    console.log("    kind:", first.kind);
    console.log("    senderAgentId:", first.senderAgentId);
    console.log("    payload keys:", first.payload ? Object.keys(first.payload) : "no payload");
    if (first.payload) {
      console.log("    payload.agentId:", first.payload.agentId);
      console.log("    payload.agentRole:", first.payload.agentRole);
      console.log("    payload.status:", first.payload.status);
    }
  }
  
  await redis.quit();
}

inspect().catch(console.error);
