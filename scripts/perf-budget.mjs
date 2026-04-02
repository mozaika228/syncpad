import { readFile } from "node:fs/promises";

const resultFile = process.env.BENCH_RESULT_FILE || "./bench-result.json";
const minOpsPerSec = Number(process.env.BENCH_MIN_OPS_PER_SEC || 250);
const minAckRatio = Number(process.env.BENCH_MIN_ACK_RATIO || 0.995);
const maxElapsedMs = Number(process.env.BENCH_MAX_ELAPSED_MS || 10000);

async function run() {
  const raw = await readFile(resultFile, "utf8");
  const result = JSON.parse(raw.trim());

  const checks = [
    {
      ok: Number(result.opsPerSec) >= minOpsPerSec,
      message: `opsPerSec ${result.opsPerSec} < min ${minOpsPerSec}`
    },
    {
      ok: Number(result.ackRatio) >= minAckRatio,
      message: `ackRatio ${result.ackRatio} < min ${minAckRatio}`
    },
    {
      ok: Number(result.elapsedMs) <= maxElapsedMs,
      message: `elapsedMs ${result.elapsedMs} > max ${maxElapsedMs}`
    }
  ];

  const failed = checks.filter((c) => !c.ok);

  if (failed.length > 0) {
    console.error("Perf budget FAILED");
    for (const item of failed) {
      console.error(`- ${item.message}`);
    }
    process.exit(1);
  }

  console.log("Perf budget passed", JSON.stringify({ minOpsPerSec, minAckRatio, maxElapsedMs, result }));
}

run().catch((err) => {
  console.error("Perf budget script failed", err);
  process.exit(1);
});