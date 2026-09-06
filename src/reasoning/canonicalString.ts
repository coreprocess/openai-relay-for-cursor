export type CanonicalSink = (chunk: string) => void;
export const STRING_SCRATCH_BYTES = 8192;

/** Native JSON escaping in bounded slices; never split a surrogate pair, including across parts. */
export const writeJsonString = (parts: Iterable<string>, sink: CanonicalSink): void => {
    sink('"');
    let pending = '';
    for (const part of parts) {
        for (let offset = 0; offset < part.length; offset += 512) {
            let chunk = pending + part.slice(offset, offset + 512);
            pending = '';
            const last = chunk.charCodeAt(chunk.length - 1);
            if (last >= 0xd800 && last <= 0xdbff) {
                pending = chunk.slice(-1);
                chunk = chunk.slice(0, -1);
            }
            if (chunk) sink(JSON.stringify(chunk).slice(1, -1));
        }
    }
    if (pending) sink(JSON.stringify(pending).slice(1, -1));
    sink('"');
};
