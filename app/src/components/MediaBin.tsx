import { useEditor } from "../store";
import type { ImportedMedia } from "../types";

function describe(m: ImportedMedia): string {
  if (m.info.is_image) return `${m.info.width}×${m.info.height}`;
  const dur = m.info.duration ? `${m.info.duration.toFixed(1)}s` : "";
  if (m.info.has_video) return `video ${dur}`;
  return `audio ${dur}`;
}

export default function MediaBin({
  onImport,
  onAddSlide,
  onAddAudio,
}: {
  onImport: () => void;
  onAddSlide: (m: ImportedMedia) => void;
  onAddAudio: (m: ImportedMedia) => void;
}) {
  const media = useEditor((s) => s.media);
  const removeMedia = useEditor((s) => s.removeMedia);

  return (
    <aside className="media-bin">
      <div className="panel-head">
        <span>Media</span>
        <button onClick={onImport}>+ Import</button>
      </div>
      {media.length === 0 && (
        <p className="hint">
          Import photos, video clips and music — or drop files anywhere in the window.
        </p>
      )}
      <div className="media-list">
        {media.map((m) => (
          <div
            key={m.path}
            className="media-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-media-path", m.path);
              e.dataTransfer.effectAllowed = "copy";
            }}
            title={m.path}
          >
            {m.thumb ? (
              <img src={m.thumb} alt="" />
            ) : (
              <div className="thumb-fallback">{m.info.has_audio && !m.info.has_video ? "♫" : "▤"}</div>
            )}
            <div className="media-meta">
              <div className="media-name">{m.path.replace(/^.*[/\\]/, "")}</div>
              <div className="media-desc">{describe(m)}</div>
              <div className="media-actions">
                {(m.info.is_image || m.info.has_video) && (
                  <button onClick={() => onAddSlide(m)} title="Append a slide with this media">
                    + Slide
                  </button>
                )}
                {m.info.has_audio && !m.info.has_video && (
                  <button onClick={() => onAddAudio(m)} title="Add as a music track">
                    + Music
                  </button>
                )}
                <button className="ghost" onClick={() => removeMedia(m.path)}>
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
