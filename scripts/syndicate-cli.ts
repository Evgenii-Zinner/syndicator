#!/usr/bin/env bun

/**
 * Command-line utility to trigger RSS sync on the Syndicator Worker.
 */

const args = process.argv.slice(2);

function hasArg(flag: string): boolean {
  return args.includes(flag);
}

const workerUrl = process.env.SYNDICATOR_URL || 'http://localhost:8787';
const apiSecret = process.env.API_SECRET;
const force = hasArg('--force') || hasArg('-f');

async function run(): Promise<void> {
  console.log(`📡 Triggering sync on ${workerUrl}...`);
  if (force) {
    console.log('⚡ Force mode enabled (bypassing transport cache)');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiSecret) {
    headers.Authorization = `Bearer ${apiSecret}`;
  }

  const res = await fetch(`${workerUrl.replace(/\/+$/, '')}/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ force }),
  });

  const data: unknown = await res.json();
  console.log('\nResult:');
  console.log(JSON.stringify(data, null, 2));

  if (!res.ok) {
    process.exit(1);
  }
}

run().catch((err: unknown) => {
  console.error('Error executing sync:', err);
  process.exit(1);
});
