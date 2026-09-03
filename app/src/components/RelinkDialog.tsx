import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { searchMediaFolder } from "../api";
import { MEDIA_EXTENSIONS } from "../App";
import { useEditor } from "../store";

const baseName = (p: string) => p.replace(/^.*[/\\]/, "");

/**
 * Point the project at media that moved on disk. Relinking is a project edit
 * like any other (one undo step per gesture); the re-import effect in App
 * probes and thumbs the new paths, so slides redraw on their own.
 */
export default function RelinkDialog({
  missing,
  onClose,
}: {
  missing: string[];
  onClose: () => void;
}) {
  const relinkMedia = useEditor((s) => s.relinkMedia);
  const [note, setNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const locate = async (path: string) => {
    const picked = await open({
      title: `Locate ${baseName(path)}`,
      multiple: false,
      filters: [
        { name: "Media", extensions: [...MEDIA_EXTENSIONS.visual, ...MEDIA_EXTENSIONS.audio] },
        // The replacement may have been re-encoded on the way; the probe, not
        // the extension, decides what the file actually is.
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    setNote(null);
    relinkMedia({ [path]: picked });
  };

  const searchFolder = async () => {
    const dir = await open({ directory: true, title: "Search a folder for the missing files" });
    if (typeof dir !== "string") return;
    setSearching(true);
    try {
      const { matches, ambiguous } = await searchMediaFolder(dir, [
        ...new Set(missing.map(baseName)),
      ]);
      const map: Record<string, string> = {};
      for (const p of missing) {
        const found: string | undefined = matches[baseName(p)];
        if (found) map[p] = found;
      }
      const hits = Object.keys(map).length;
      relinkMedia(map);
      const left = missing.length - hits;
      const dupes = ambiguous.length
        ? ` ${ambiguous.length} name${ambiguous.length === 1 ? "" : "s"} appeared more than once — the shallowest copy won.`
        : "";
      setNote(
        hits === 0
          ? "Nothing in that folder matched by name."
          : `Relinked ${hits} of ${missing.length}${left ? `, ${left} still missing` : ""}.${dupes}`,
      );
    } catch (e) {
      setNote(String(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Missing files</h2>
        {missing.length === 0 ? (
          <p className="hint">Everything the project uses is linked again.</p>
        ) : (
          <>
            <p className="hint">
              {missing.length} file{missing.length === 1 ? " is" : "s are"} no longer where the
              project left {missing.length === 1 ? "it" : "them"}. Point at the new location, or
              search a folder for all of them at once.
            </p>
            <ul className="relink-list">
              {missing.map((p) => (
                <li key={p} className="relink-row">
                  <div className="relink-file">
                    <div className="relink-name">{baseName(p)}</div>
                    <div className="relink-path" title={p}>
                      {p}
                    </div>
                  </div>
                  <button onClick={() => locate(p)}>Locate…</button>
                </li>
              ))}
            </ul>
          </>
        )}
        {note && <p className="hint">{note}</p>}
        <div className="row right">
          <button onClick={onClose}>Close</button>
          {missing.length > 0 && (
            <button className="primary" onClick={searchFolder} disabled={searching}>
              {searching ? "Searching…" : "Search folder…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
