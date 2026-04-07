const Redis = require("ioredis");
const redis = new Redis("redis://localhost:6379");

async function test() {
  // Get all agent index keys
  const keys = await redis.keys("tenclaw:workflow:index:agent:*");
  console.log("Agent index keys:", keys);
  
  for (const key of keys) {
    const parts = key.split(":");
    const agentId = parts[parts.length - 1];
    const count = await redis.zcard(key);
    console.log(`Agent ${agentId}: ${count} runs`);
  }
  
  await redis.quit();
}

test().catch(console.error);
