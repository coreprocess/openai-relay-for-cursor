// Local-only inspection of this harness's private logs; prints structure/counts, never ciphertext.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OutputCapture } from '../src/reasoning/capture.ts';
import { createResponsesToChatStreamConverter } from '../src/convertStream.ts';
import type { ResponsesStreamEvent } from '../src/responsesTypes.ts';
import { readSseEvents } from '../src/sse.ts';
import { DatabaseSync } from 'node:sqlite';

const directory = process.argv[2];
if (!directory?.startsWith('/tmp/openai-replay-live-')) throw new Error('Only test-owned log directories permitted');
const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
for (const entry of summary.cases) {
    const capture = new OutputCapture();
    const path = join(directory, 'logs', entry.logFiles.upstream);
    if (!path.endsWith('.sse')) continue;
    const raw = await readFile(path);
    async function* chunks() { yield raw; }
    const convert = createResponsesToChatStreamConverter();
    const kinds: Record<string, number> = {};
    const finalized = new Map<number, Record<string, unknown>>();
    let terminal;
    for await (const event of readSseEvents(chunks())) {
        const parsed = JSON.parse(event.data) as ResponsesStreamEvent;
        kinds[parsed.type] = (kinds[parsed.type] ?? 0) + 1;
        if (parsed.type === 'response.output_item.done') finalized.set(parsed.output_index!, parsed.item!);
        capture.addEvent(parsed);
        for (const frame of convert(parsed)) capture.addFrame(frame);
        if (parsed.type === 'response.completed') terminal = parsed.response;
    }
    const result = capture.finish(terminal);
    console.log(JSON.stringify({ label: entry.label, kinds, complete: result.complete, admissible: result.admissible,
        debugState: Object.fromEntries(['invalid', 'completed', 'clientDone', 'roleSeen', 'known', 'finishReason', 'snapshot', 'clientModel'].map((key) => [key, (capture as unknown as Record<string, unknown>)[key]])),
        doneDifferences: terminal?.output?.map((item, index) => ({ index, differences: [...new Set([...Object.keys(item), ...Object.keys(finalized.get(index) ?? {})])].filter((key) => JSON.stringify((item as Record<string, unknown>)[key]) !== JSON.stringify(finalized.get(index)?.[key])) })),
        envelopeKnown: result.envelope !== null, outputFields: result.output?.map((item) => ({ type: item.type, fields: Object.keys(item) })),
        reasoningBytes: result.output?.filter((item) => item.type === 'reasoning').map((item) => String(item.encrypted_content ?? '').length),
    }));
}
const db = new DatabaseSync(join(directory, 'cache.sqlite'), { readOnly: true });
console.log(JSON.stringify({ observations: db.prepare('SELECT generation, replayable, snapshot, length(prior_plan) planBytes FROM observations').all(),
    intents: db.prepare('SELECT count(*) count FROM intents').get(), markers: db.prepare('SELECT kind,count(*) count FROM markers GROUP BY kind').all() }));
db.close();
