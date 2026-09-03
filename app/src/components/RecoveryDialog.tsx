import { useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { clearAutosave, loadProject } from "../api";
import { relativeTime, useRecovery } from "../autosave";
import { useEditor } from "../store";
import type { RecoveryOffer } from "../autosave";

export default function RecoveryDialog({ offer }: { offer: RecoveryOffer }) {
  const setOffer = useRecovery((s) => s.setOffer);
  const replaceProject = useEditor((s) => s.replaceProject);
  const markDirty = useEditor((s) => s.markDirty);
  const [busy, setBusy] = useState(false);

  const fileName = offer.projectPath ? offer.projectPath.replace(/^.*[/\\]/, "") : "Untitled";

  const restore = async () => {
    setBusy(true);
    try {
      const p = await loadProject(offer.info.path);
      replaceProject(p, { path: offer.projectPath });
      // Recovered work has never been written to the project file.
      markDirty();
      setOffer(null);
    } catch (e) {
      setBusy(false);
      void message(`Could not restore the recovered changes:\n${e}`, {
        title: "Restore failed",
        kind: "error",
      });
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await clearAutosave(offer.projectPath);
    } catch (e) {
      console.warn("discarding autosave failed", e);
    }
    setOffer(null);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Unsaved changes</h2>
        <p>Recovered unsaved changes from {relativeTime(offer.info.modified_ms)}.</p>
        <p className="hint">
          {fileName} — the app closed before these edits were saved. Discarding keeps the last
          saved version.
        </p>
        <div className="row right">
          <button onClick={discard} disabled={busy}>
            Discard
          </button>
          <button className="primary" onClick={restore} disabled={busy}>
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}
