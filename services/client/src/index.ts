interface Tally {
  ok: number;
  throttled: number;
  unavailable: number;
  error: number;
}

const gateways = (process.env.GATEWAY_URLS ?? 'http://gateway-1:3000')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const clientIds = (process.env.CLIENT_IDS ?? 'alice')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const targetPath = process.env.TARGET_PATH ?? '/api/resource';
const rps = Number(process.env.RPS ?? 30);
const durationSec = Number(process.env.DURATION_SEC ?? 15);

const stats = new Map<string, Tally>(
  clientIds.map((id) => [id, { ok: 0, throttled: 0, unavailable: 0, error: 0 }]),
);

let sent = 0;

async function fire(index: number): Promise<void> {
  const gateway = gateways[index % gateways.length] as string;
  const clientId = clientIds[index % clientIds.length] as string;
  const tally = stats.get(clientId);
  if (!tally) return;

  try {
    const res = await fetch(`${gateway}${targetPath}`, {
      headers: { 'x-client-id': clientId },
    });
    if (res.status === 429) tally.throttled += 1;
    else if (res.status === 503) tally.unavailable += 1;
    else if (res.ok) tally.ok += 1;
    else tally.error += 1;
  } catch {
    tally.error += 1;
  }
}

console.log(
  `load: ${rps} rps for ${durationSec}s across ${gateways.length} gateways, clients=${clientIds.join(',')}`,
);

const interval = setInterval(() => {
  for (let n = 0; n < rps; n += 1) void fire(sent++);
}, 1000);

setTimeout(() => {
  void (async () => {
    clearInterval(interval);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log('\nresults:');
    for (const [clientId, tally] of stats) {
      console.log(
        `  ${clientId}: allowed=${tally.ok} throttled=${tally.throttled} unavailable=${tally.unavailable} errors=${tally.error}`,
      );
    }
    process.exit(0);
  })();
}, durationSec * 1000);
