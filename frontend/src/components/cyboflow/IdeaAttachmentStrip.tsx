/**
 * IdeaAttachmentStrip — presentational previews row + "Attach file" control for
 * the idea editors (migration 028). State/handlers come from useIdeaAttachments;
 * this component only renders the previews, a remove button per attachment, and
 * a hidden file input behind the attach pill. Any file type is accepted: images
 * render an actual thumbnail, everything else renders a compact icon+name chip
 * (previewing non-image bytes is out of scope — the file icon is enough).
 */
import { useRef } from 'react';
import { Paperclip, X, File, FileText, FileAudio, FileVideo, FileArchive, FileCode } from 'lucide-react';
import type { AttachmentPreview } from '../../hooks/useIdeaAttachments';

interface IdeaAttachmentStripProps {
  previews: AttachmentPreview[];
  busy: boolean;
  error: string | null;
  onAddFiles: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
}

/** Pick a representative lucide icon for a non-image MIME type, by family. */
function iconForMime(type: string): typeof File {
  if (type.startsWith('audio/')) return FileAudio;
  if (type.startsWith('video/')) return FileVideo;
  if (type === 'application/zip' || type.includes('compressed') || type.includes('archive')) return FileArchive;
  if (type === 'application/json' || type.includes('javascript') || type.includes('typescript')) return FileCode;
  if (type === 'application/pdf' || type.startsWith('text/')) return FileText;
  return File;
}

export function IdeaAttachmentStrip({
  previews,
  busy,
  error,
  onAddFiles,
  onRemove,
}: IdeaAttachmentStripProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-1.5" data-testid="idea-attachment-strip">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-secondary">Attachments</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          data-testid="idea-attach-file"
          className="inline-flex items-center gap-1 rounded-button border border-border-primary bg-bg-primary px-2 py-0.5 text-[11px] font-semibold text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Paperclip size={12} />
          {busy ? 'Saving…' : 'Attach file'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onAddFiles(e.target.files);
            }
            e.target.value = '';
          }}
        />
      </div>

      {previews.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {previews.map((p) => {
            const isImage = p.type.startsWith('image/');
            const Icon = isImage ? null : iconForMime(p.type);
            return (
              <div
                key={p.id}
                className="group relative h-16 w-16 overflow-hidden rounded-input border border-border-primary bg-bg-primary"
                title={p.name}
                data-testid="idea-attachment-item"
              >
                {isImage ? (
                  p.dataUrl ? (
                    <img src={p.dataUrl} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[9px] text-text-muted">
                      …
                    </div>
                  )
                ) : (
                  <div
                    className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-text-secondary"
                    data-testid="idea-attachment-file-chip"
                  >
                    {Icon && <Icon size={18} />}
                    <span className="w-full truncate text-center text-[9px]">{p.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(p.id)}
                  aria-label={`Remove ${p.name}`}
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-primary/80 text-text-secondary opacity-0 transition-opacity hover:text-status-error group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p className="text-[11px] text-status-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
