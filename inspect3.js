const Redis = require("ioredis");
const redis = new Redis("redis://localhost:6379");

async function inspect() {
  // Check the agent index key
  const key = "tenclaw:workflow:index:agent:demo-tenant:demo-workspace:demo-project:planner";
  const type = await redis.type(key);
  console.log("Key type:", type);
  
  if (type === "zset") {
    const data = await redis.zrange(key, 0, -1, "WITHSCORES");
    console.log("Sorted set entries (first 10):", data.slice(0, 10));
  } else if (type === "string") {
    const data = await redis.get(key);
    console.log("String value:", data?.substring(0, 500));
  }
  
  // Also check the audit log stream
  const auditKey = "tenclaw:demo-tenant:demo-workspace:audit-log";
  const auditType = await redis.type(auditKey);
  console.log("\nAudit log key type:", auditType);
  
  if (auditType === "stream") {
    const auditData = await redis.xrange(auditKey, "-", "+", "COUNT", 5);
    console.log("Audit log entries (first 5):");
    auditData.forEach(([id, fields]) => {
      const obj = {};
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      console.log("  -", id, obj.eventType || "unknown");
    });
  }
  
  await redis.quit();
}

inspect().catch(console.error);
