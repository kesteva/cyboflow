/**
 * IdeaAttachmentStrip — presentational thumbnail row + "Attach image" control
 * for the idea editors (migration 028). State/handlers come from
 * useIdeaAttachments; this component only renders the previews, a remove button
 * per image, and a hidden file input behind the attach pill.
 */
import { useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import type { AttachmentPreview } from '../../hooks/useIdeaAttachments';

interface IdeaAttachmentStripProps {
  previews: AttachmentPreview[];
  busy: boolean;
  error: string | null;
  onAddFiles: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
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
        <span className="text-xs font-medium text-text-secondary">Images</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          data-testid="idea-attach-image"
          className="inline-flex items-center gap-1 rounded-button border border-border-primary bg-bg-primary px-2 py-0.5 text-[11px] font-semibold text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ImagePlus size={12} />
          {busy ? 'Saving…' : 'Attach image'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
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
          {previews.map((p) => (
            <div
              key={p.id}
              className="group relative h-16 w-16 overflow-hidden rounded-input border border-border-primary bg-bg-primary"
              title={p.name}
            >
              {p.dataUrl ? (
                <img src={p.dataUrl} alt={p.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[9px] text-text-muted">
                  …
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
          ))}
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
