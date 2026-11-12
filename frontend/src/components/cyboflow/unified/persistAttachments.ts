/**
 * Composer attachment persistence — turns the composer-owned images / large
 * pasted texts into on-disk files and folds their absolute paths into the
 * outgoing message body.
 *
 * Every agent surface in the app consumes attachments the same way: the files
 * are written under `CYBOFLOW_DIR/artifacts/<ownerId>/` and the message carries
 * an `<attachments>` block listing the paths, which the agent then reads with
 * its own file tools. There is NO binary transport — the SDK/PTY send paths are
 * plain text, so the path list IS the attachment.
 *
 * `ownerId` is the artifacts-dir key: a session id for quick-session chat, or a
 * WORKFLOW RUN id for the run-chat composer and the question gate (the main
 * process accepts either — see `assertAttachmentOwner` in ipc/session.ts).
 *
 * Unlike useClaudePanel's inline copies, a persistence failure REJECTS instead
 * of sending the text without its attachments: UnifiedComposer keeps the
 * attachments on a rejected submit, so the user can retry rather than discover
 * later that the screenshot they were pointing at never arrived.
 */
import type { ComposerAttachments } from './attachments';

const PREAMBLE = 'Please look at these files which may provide additional instructions or context:';

/**
 * The main process's own message from a rejected `ipcRenderer.invoke` (Electron wraps a handler's throw as
 * "Error invoking remote method '<channel>': Error: <message>"), so a refusal such as "Attachments is not
 * available on remote environments." reads as itself in the composer error line.
 */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^Error invoking remote method '[^']*': (?:\w*Error: )?([\s\S]*)$/.exec(raw);
  return m ? m[1] : raw;
}

/** Save the attachments and return their absolute on-disk paths (in order). */
export async function persistAttachments(
  ownerId: string,
  atts: ComposerAttachments,
): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const t of atts.texts) {
      paths.push(await window.electronAPI.sessions.saveLargeText(ownerId, t.content));
    }
    if (atts.images.length > 0) {
      paths.push(
        ...(await window.electronAPI.sessions.saveImages(
          ownerId,
          atts.images.map((img) => ({ name: img.name, dataUrl: img.dataUrl, type: img.type })),
        )),
      );
    }
  } catch (err: unknown) {
    throw new Error(ipcErrorMessage(err));
  }
  return paths;
}

/** The `<attachments>` block appended to a message body, or '' when there are none. */
export function attachmentsBlock(paths: string[]): string {
  if (paths.length === 0) return '';
  return `\n\n<attachments>\n${PREAMBLE}\n${paths.join('\n')}\n</attachments>`;
}

/**
 * Persist `atts` and return the message body to actually send. Rejects if any
 * file fails to save (the caller must NOT fall back to sending bare text).
 */
export async function composeWithAttachments(
  text: string,
  atts: ComposerAttachments,
  ownerId: string,
): Promise<string> {
  return `${text}${attachmentsBlock(await persistAttachments(ownerId, atts))}`;
}
