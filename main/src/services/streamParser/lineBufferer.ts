/**
 * LineBufferer — Stage 1 of the streamParser pipeline.
 *
 * Converts a stream of arbitrary string chunks into complete lines, preserving
 * partial trailing content across chunk boundaries. CRLF-safe (strips \r).
 *
 * Invariant: if the same data is fed in 1-byte chunks vs. 1024-byte chunks vs.
 * a single chunk, the sequence of lines returned (including via flush) is identical.
 */

export class LineBufferer {
  private buffer = '';

  /**
   * Ingest a chunk of stdout text.
   *
   * Appends the chunk to the internal buffer, splits on '\n', and returns all
   * complete lines (everything except the last element, which becomes the new
   * partial buffer). Returns an empty array when no newline is present in the
   * chunk — the data is held until the next chunk completes it.
   *
   * Each returned line has its trailing '\r' stripped (CRLF safety).
   */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    // The last element may be an incomplete line — keep it in the buffer.
    this.buffer = parts[parts.length - 1];
    // Return all complete lines (everything before the last element), stripping \r.
    return parts.slice(0, -1).map((line) => line.replace(/\r$/, ''));
  }

  /**
   * Flush any remaining buffered content as a final line.
   *
   * Call this when the stream ends (EOF / process exit) to emit any partial
   * data that was never followed by a newline. Returns an empty array if the
   * buffer is empty. Clears the buffer after returning.
   */
  flush(): string[] {
    const remaining = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    return remaining.length > 0 ? [remaining] : [];
  }
}
