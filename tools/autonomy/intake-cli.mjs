import {maxInputBytes, parseCandidate} from './feedback-intake.mjs';

const chunks = [];
let size = 0;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxInputBytes) throw new Error('Input too large.');
    chunks.push(chunk);
  }
  process.stdout.write(JSON.stringify(parseCandidate(Buffer.concat(chunks).toString('utf8'))) + '\n');
} catch {
  // Never echo attacker-controlled input or raw parser diagnostics.
  process.stderr.write('Feedback intake rejected invalid input.\n');
  process.exitCode = 1;
}
